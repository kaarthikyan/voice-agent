const express = require("express");
const process = require("node:process");
const dotenv = require("dotenv");
const { AccessToken } = require("livekit-server-sdk");
const Groq = require("groq-sdk");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ dest: "uploads/" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const speechClient = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

function createLiveKitToken(identity) {
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
        throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set");
    }
    const token = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        { identity }
    );
    token.addGrant({ roomJoin: true, room: 'insurance-room' });
    return token.toJwt();
}


app.post('/call', upload.single('audio'), async (req, res) => {
    const callerId = req.body.callerId || 'caller';
    const token = createLiveKitToken(callerId);

    // 1. Transcribe audio to text
    const audioPath = req.file.path;
    const file = fs.readFileSync(audioPath);
    const audioBytes = file.toString('base64');

    const [sttResponse] = await speechClient.recognize({
        audio: { content: audioBytes },
        config: {
            encoding: 'WEBM_OPUS',
            sampleRateHertz: 48000,
            languageCode: 'en-US',
        },
    });
    const userText = sttResponse.results?.[0]?.alternatives?.[0]?.transcript || 'I had an accident, what should I do?';

    console.log("Transcribed Text:", userText);
    // 2. Get response from Groq
    const groqResponse = await groq.chat.completions.create({
        messages: [
            { role: 'system', content: 'You are an insurance agent U.S based.' },
            { role: 'user', content: userText }
        ],
        model: 'allam-2-7b'
    });
    const reply = groqResponse.choices?.[0]?.message?.content ?? "No response from Groq.";

    // 3. Synthesize reply to audio
    const [ttsResponse] = await ttsClient.synthesizeSpeech({
        input: { text: reply },
        voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
    });

    // 4. Send audio file directly as download
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="reply.mp3"');
    res.send(ttsResponse.audioContent);

    // Clean up uploaded file
    fs.unlink(audioPath, () => {});
});

app.post('/speak', async (req, res) => {
    const text = req.body.text;
    if (!text) {
        res.status(400).send('Missing text');
        return;
    }

    const [ttsResponse] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="speech.mp3"');
    res.send(ttsResponse.audioContent);
});

app.post('/speak-reply', async (req, res) => {
    const text = req.body.text;
    if (!text) {
        res.status(400).send('Missing text');
        return;
    }

    // Get reply from Groq NLP agent
    const groqResponse = await groq.chat.completions.create({
        messages: [
            { role: 'system', content: 'You are an insurance agent U.S based.' },
            { role: 'user', content: text }
        ],
        model: 'allam-2-7b'
    });
    const reply = groqResponse.choices?.[0]?.message?.content ?? "No response from Groq.";

    // Synthesize reply to audio
    const [ttsResponse] = await ttsClient.synthesizeSpeech({
        input: { text: reply },
        voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="reply.mp3"');
    res.send(ttsResponse.audioContent);
});

app.listen(8080, () => {
    console.log('Insurance Voice Agent running on port 8080');
});
