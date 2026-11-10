# Lock Down the Office: data privacy escape room

A single-file browser game. Walk the commute from the car park to the server room, fix the privacy risks on the way, collect a 4-digit code and escape before the timer runs out.

**Play:** open `index.html` in Chrome or Edge (or enable GitHub Pages for this repo and open the Pages link).

## Controls
- Hand: point your index finger to move the ring, pinch (or hold still 1.5 s) to click, open palm for a hint.
- Voice: say "A", "B", "C", "hint", "repeat", "pause", "next", or the code digits at the keypad.
- Mouse and keyboard work for everything.

## Edit the questions
Open `index.html` in a text editor and look for the block marked **THE QUESTIONS** near the top of the script. The settings (timer, penalty, hints, pass mark) are just above it. The current questions are general good-practice placeholders: replace them with your course questions.

Hand tracking loads MediaPipe from jsdelivr and Google's model host, so the first run needs internet access. If that is blocked, the game falls back to the mouse.
