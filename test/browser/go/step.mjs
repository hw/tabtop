// A step of the remote browser's check (go-check.mjs), said as it passes
// or fails.

// GO_ONLY runs only the steps whose names have its text in them; GO_FROM,
// those from the first that has it on (a check resumed where one failed).
// Logging in is run whichever.
let stepsReached = false;
export async function step(name, f) {
    const only = process.env.GO_ONLY, from = process.env.GO_FROM;
    if (from && name.includes(from)) stepsReached = true;
    if (name !== "log in on /go" && ((only && !name.includes(only)) || (from && !stepsReached))) return;
    const t = Date.now();
    try {
        const note = await f();
        console.log(`ok   ${name}${note ? ` (${note})` : ""} ${Date.now() - t} ms`);
    } catch (err) {
        console.log(`FAIL ${name}: ${err.message}`);
        throw err;
    }
}
