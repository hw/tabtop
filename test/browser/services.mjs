export async function checkServices({ step, ev, waitFor, sleep }) {
    await step("terminal: file support disabled", async () => {
        await waitFor(`!!document.querySelector("#terminal canvas") && !document.querySelector("#tabtop_login")`, "the terminal");
        if (await ev(`!!document.querySelector('.tabtop-nav a[href*="/fs/"]')`)) throw new Error("disabled files remain in navigation");
        const before = await ev("window.sockets.length");
        await ev(`(() => {
            const data = new DataTransfer(); data.items.add(new File(["test"], "disabled.txt"));
            document.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
            document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        })()`);
        await sleep(250);
        if (await ev(`document.body.classList.contains("dropping") || !!document.querySelector("#drop_overlay, #uploads")`) ||
            await ev("window.sockets.length") !== before) throw new Error("disabled file uploads installed UI or opened a tunnel");
        return "drag/drop and pasted files install no upload UI or file requests";
    });
}
