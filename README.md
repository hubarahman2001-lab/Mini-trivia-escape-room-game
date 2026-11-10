# Lock Down the Office: data privacy escape room

A single-file browser game you play with your hands. Walk the commute from the car park to the server room, physically fix the privacy risks on the way, collect a four-digit all-clear code and send it before the building locks down.

**Play online:** https://hubarahman2001-lab.github.io/Mini-trivia-escape-room-game/

**Play offline:** open `index.html` in Chrome or Edge.

**Source:** https://github.com/hubarahman2001-lab/Mini-trivia-escape-room-game

## Story
It's 7:45 pm and you came back for your charger. A visitor badge went missing today, so Sam from Security is sealing the building in ten minutes. Sam guides you over the radio from the car park to the server room. Each zone you clear earns one digit of the all-clear code.

## How the hand controls work
The webcam tracks your hand, and a glowing outline of it follows your finger on screen. You fix each risk with a real gesture:

| Gesture | Used for |
|---|---|
| ☝️ Point | Move around the screen |
| 🤏 Pinch and drag | Clip on your badge, tap card readers, put the visitor log in the drawer, peel off the sticky note, file the Finance binders, sort printouts into shredder / cabinet / recycling |
| ✋ Open palm | Stop the tailgater, hold the lift doors, wipe the whiteboard, push the volume down |
| ✊ Fist | Lock the laptop, and lock in an answer |
| 👋 Swipe | Swing the open side door shut |
| 🤏 Pinch and twist | Turn the cabinet key |
| 1 to 4 fingers, then a fist | Answer questions and enter the keypad code |
| 👍 Thumbs up | Continue, walk on |

A short hand check at the start teaches the moves and confirms the camera can see them.

**No camera?** Choose "Play with mouse". Every task also works with click, drag and hold.
**Voice** (Chrome or Edge): say "A", "B", "C", "hint", "repeat", "pause", "next", or the code digits at the keypad.

## Edit the questions
Open `index.html` in a text editor and find **2. STORY AND QUESTIONS** near the top of the script:
- `DECISIONS`: the judgment-call questions (one correct option each, plus the explanation shown afterwards).
- `PAGES`: the printouts in the sorting task and where each one belongs.
- `SCENES`: Sam's radio lines and the lesson shown after each task.

The settings (timer, penalty, hints, pass mark) are just above that block. The current questions are general good-practice placeholders: replace them with your course questions before real use.

## Notes
- Hand tracking loads MediaPipe from jsdelivr and Google's model host, so the first run needs internet access. If that is blocked, the game falls back to the mouse.
- Camera and microphone only work over https (the GitHub Pages link) or when the file is opened locally. Nothing is recorded or sent anywhere.
