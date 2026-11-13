# Lock Down the Office: data privacy escape room

A browser game you play with your hands. Walk the commute from the car park to the server room, find and fix the privacy risks on the way, collect a four-digit all-clear code and send it before the building locks down.

**Play online:** https://hubarahman2001-lab.github.io/Mini-trivia-escape-room-game/

**Play from your computer:** keep the files and the `models` folder together and open `index.html` in Chrome or Edge. Opened this way, the voice downloads its model from huggingface.co; from the web address it uses the game's own `models` folder.

**Source:** https://github.com/hubarahman2001-lab/Mini-trivia-escape-room-game

## Story
It's 7:45 pm and you came back for your charger. A visitor badge went missing today, so Sam from Security is sealing the building in fifteen minutes. Sam talks to you over the radio from the car park to the server room. Each zone you clear earns one digit of the all-clear code.

## How you play
Most rooms don't tell you what's wrong. Sam gives a short brief, and you search the scene yourself: point at anything that looks like a risk and pinch it (or click it). Some harmless things are decoys and cost 5 seconds. Once you've found a risk, work out what to do about it with your hands; the exact move is only shown after a hint or if you're stuck for a while.

You get **3 hints** per run: hold up a ✌️ peace sign, press **H**, or click 💡. In a room a hint shows where a risk is; on a found risk it shows the move; on a question it crosses out a wrong answer.

## How the hand controls work
The webcam tracks your hand, and a glowing outline of it follows your finger on screen.

| Gesture | Used for |
|---|---|
| ☝️ Point | Move around the screen |
| 🤏 Pinch | Find a risk, pick things up and drag them, choose an answer or keypad digit |
| ✋ Open palm | Stop the tailgater, hold the lift doors, push the volume down |
| ✊ Fist | Lock the laptop |
| 👋 Swipe | Swing the open side door shut |
| 🤏 Pinch and twist | Turn the cabinet key |
| Any hand, rubbed across | Wipe the whiteboard (the dashed circle is your eraser) |
| ✌️ Peace sign | Use a hint |
| 👍 Thumbs up | Continue, walk on |

Answers and keypad digits can also be chosen by holding your hand still on them. A short hand check at the start teaches the moves and confirms the camera can see them.

**Tips for the camera:** sit about an arm's length away with your whole hand in view. The camera preview (bottom left) shows a dashed box: keep your hand inside it. The preview shows the move the game sees and tells you to raise or lower your hand if it drifts out.

**No camera?** Choose "Play with mouse". Everything also works with click, drag and hold.

**Voice commands** (Chrome or Edge): "answer A" (or just "A", "B", "C"), "hint", "repeat", "pause", "next", or the code digits at the keypad.

## Sam's voice
Sam and the questions are read aloud with Kokoro, a speech model that runs in the browser (no server, no keys). The model is hosted with the game in `models/Kokoro-82M-v1.0-ONNX/`, so it doesn't depend on huggingface.co. The first visit downloads it once (about 330 MB with WebGPU, about 90 MB on the CPU), then the browser keeps it. Sam's next lines are made in the background while you play, so they start without a wait. If the voice can't load, the game uses the browser's own voice. Mute with 🔊. Setup, settings and moving the model to an internal server: `VOICE-INTEGRATION.md`.

## Edit the questions
Open `index.html` in a text editor and find **2. STORY AND QUESTIONS** near the top of the script:
- `DECISIONS`: the judgment-call questions (one correct option each, plus the explanation shown afterwards).
- `PAGES`: the printouts in the sorting task and where each one belongs.
- `SCENES`: Sam's lines, the risks to find in each room (with their hints and decoys), and the lesson shown after each one.

The settings (timer, penalties, hints, pass mark) are just above that block. The current questions are general good-practice placeholders: replace them with your course questions before real use.

## Notes
- Hand tracking loads MediaPipe from jsDelivr and Google's model host, and the voice loads kokoro-js from jsDelivr, so the first run needs internet access. If hand tracking is blocked, the game falls back to the mouse; if the voice is, it uses the browser's own voice.
- Camera and microphone work over https (the GitHub Pages link) or when the file is opened locally. Nothing is recorded or sent anywhere.
