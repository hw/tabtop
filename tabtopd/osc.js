// The most a program may copy at once, in base64 bytes.
const maxCopy = 1 << 20;

// Osc watches the output, across message boundaries, for what ghostty-web
// doesn't do itself:
//   - OSC 52 (ESC ] 52 ; <selection> ; <base64>, ended by BEL or ESC \),
//     which lets programs in the terminal (tmux's copy mode, ssh-yank.sh)
//     copy to the browser's clipboard. Requests to read the clipboard ("?")
//     get nothing back, so programs can't see what the viewer copied
//     elsewhere. What's copied is passed to onCopy, for the page to say so:
//     anything shown in the terminal can copy, a file being shown or a
//     remote host included, so a command slipped onto the clipboard
//     shouldn't go unnoticed.
//   - A bell (BEL outside an OSC, where it ends one), passed to onBell.
//   - A notification, OSC 9 ; <text> (iTerm2's) or OSC 777 ; notify ;
//     <title> ; <text> (urxvt's, as the notify command sends), passed to
//     onNotify(title, text). tmux only passes these on wrapped for its
//     passthrough, as notify does.
export class Osc {
    constructor(onBell, onNotify, onCopy) {
        this.onBell = onBell;
        this.onNotify = onNotify;
        this.onCopy = onCopy;
        this.state = 0;  // 0 text, 1 after ESC, 2 in an OSC, 3 ESC in an OSC
        this.buf = [];
    }

    scan(bytes) {
        for (const b of bytes) {
            switch (this.state) {
            case 0:
                if (b === 0x1b) {
                    this.state = 1;
                } else if (b === 0x07) {
                    this.onBell();
                }
                break;
            case 1:
                this.state = b === 0x5d ? 2 : b === 0x1b ? 1 : 0;  // "]"
                this.buf = [];
                break;
            case 2:
                if (b === 0x07) {
                    this.end();
                } else if (b === 0x1b) {
                    this.state = 3;
                } else if (this.buf.length > maxCopy + 16) {
                    this.state = 0;  // too long: drop it
                } else {
                    this.buf.push(b);
                }
                break;
            case 3:
                if (b === 0x5c) {  // backslash
                    this.end();
                } else {
                    this.state = b === 0x5d ? 2 : b === 0x1b ? 1 : 0;
                    this.buf = [];
                }
                break;
            }
        }
    }

    end() {
        this.state = 0;
        if (this.buf[0] === 0x39 || this.buf[0] === 0x37) {  // "9", "7"
            this.notification();
            return;
        }
        // 52;<selection>;<data>, in ASCII.
        if (this.buf[0] !== 0x35 || this.buf[1] !== 0x32 || this.buf[2] !== 0x3b) {
            return;
        }
        const s = new TextDecoder("latin1").decode(Uint8Array.from(this.buf));
        const data = s.slice(s.indexOf(";", 3) + 1);
        if (data === "?" || data.length > maxCopy) {
            return;
        }
        try {
            const text = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
            this.onCopy(text);
        } catch {
            // Not base64: ignore it.
        }
    }

    // notification passes on OSC 9 or 777's text, in UTF-8. OSC 9 followed
    // by a number and ";" is ConEmu's (progress and such), not a message.
    notification() {
        const s = new TextDecoder().decode(Uint8Array.from(this.buf.slice(0, 4096)));
        let m = /^9;(.*)$/s.exec(s);
        if (m && !/^\d+(;|$)/.test(m[1])) {
            this.onNotify("", m[1]);
        } else if ((m = /^777;notify;([^;]*);(.*)$/s.exec(s))) {
            this.onNotify(m[1], m[2]);
        }
    }
}
