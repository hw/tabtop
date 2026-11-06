import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { zipFile } from "./fixtures.mjs";

export async function checkZIP(checks) {
    const { work, container, inContainer, step, ev, waitFor, click, open, listed } = checks;
    await step("files: preview ZIP contents", async () => {
        const entries = [["folder/", ""], ["hello.txt", "hello"], ["<img src=x onerror=alert(1)>", "inert"]];
        for (let n = 0; n < 650; n++) entries.push([`folder/item-${n}.txt`, "content"]);
        const archive = zipFile(entries);
        const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        archive.writeUInt16LE(1, central + 8); // Metadata-only encrypted entry.
        const end = archive.subarray(archive.length - 22);
        const directorySize = end.readUInt32LE(12);
        const fake = Buffer.from(archive.subarray(central, central + directorySize));
        fake.write("decoy//", 46);
        writeFileSync(`${work}/listing.zip`, Buffer.concat([archive.subarray(0, archive.length - 22), Buffer.from("GAP!"), fake, end]));
        const encoded = zipFile([["cafe.txt", "x"]]);
        encoded[33] = 0x82; // CP437 é in local and central filenames.
        encoded[encoded.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 49] = 0x82;
        writeFileSync(`${work}/encoding.zip`, encoded);
        writeFileSync(`${work}/empty.zip`, zipFile([]));
        writeFileSync(`${work}/broken.zip`, "not a zip");
        for (const name of ["listing.zip", "encoding.zip", "empty.zip", "broken.zip"]) {
            execFileSync("docker", ["cp", "-q", `${work}/${name}`, `${container}:/home/user/Downloads/media/${name}`]);
            execFileSync("docker", ["exec", container, "chown", "user", `/home/user/Downloads/media/${name}`]);
        }
        await open("fs/#/media/", `${listed}.includes("listing.zip")`, "the ZIP files");
        const show = async (name) => {
            await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === ${JSON.stringify(name)}).click()`);
            await waitFor(`!!document.querySelector("dialog.preview .zip-listing")`, name + " contents");
        };
        const close = async () => {
            await ev(`document.querySelector("dialog.preview button.close").click()`);
            await waitFor(`!document.querySelector("dialog.preview")`, "ZIP preview closed");
        };
        await show("listing.zip");
        const details = await ev(`({ rows: document.querySelectorAll(".zip-table tbody tr").length, text: document.querySelector(".zip-listing").textContent,
            injected: document.querySelectorAll(".zip-table img, .zip-table script, .zip-table a").length })`);
        if ((await ev(`document.querySelector(".zip-table tbody td").textContent`)) !== "folder/") throw new Error("ZIP preview followed the decoy directory");
        if (details.rows !== 500 || !details.text.includes("653 entries") || !details.text.includes("Encrypted") || !details.text.includes("<img src=x onerror=alert(1)>") || details.injected) throw new Error(`ZIP listing: ${JSON.stringify(details)}`);
        await ev(`document.querySelector(".zip-scroll > button").click()`);
        await waitFor(`document.querySelectorAll(".zip-table tbody tr").length === 653`, "all ZIP rows");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = "item-649"; b.dispatchEvent(new Event("input")); })()`);
        await waitFor(`document.querySelectorAll(".zip-table tbody tr").length === 1 && document.querySelector(".zip-table tbody td").textContent === "folder/item-649.txt"`, "ZIP path filtered");
        await ev(`document.querySelector(".zip-select-shown").click()`);
        if (!(await ev(`document.querySelector(".zip-select-shown").checked && document.querySelector(".zip-selection-summary").textContent.includes("1 file selected · 7 B")`))) throw new Error("shown-row selection or size missing");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = "hello"; b.dispatchEvent(new Event("input")); })()`);
        if (!(await ev(`document.querySelector(".zip-selection-summary").textContent.includes("1 not shown") && !document.querySelector(".zip-select-shown").checked`))) throw new Error("hidden selection not explained");
        await ev(`document.querySelector(".zip-clear-selection").click()`);
        if (!(await ev(`document.querySelector(".zip-extract-selected").disabled`))) throw new Error("Clear selection failed");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = "item-649"; b.dispatchEvent(new Event("input")); })()`);
        await ev(`document.querySelector(".zip-table tbody .zip-extract-one").click()`);
        await waitFor(`document.querySelector(".zip-extract-status")?.textContent.includes("Extracted 1 file into media/listing")`, "one ZIP entry extracted");
        if (inContainer("cat", "/home/user/Downloads/media/listing/folder/item-649.txt") !== "content") throw new Error("wrong extracted payload");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = ""; b.dispatchEvent(new Event("input")); })()`);
        if (!(await ev(`document.querySelector(".zip-table tbody input").disabled`))) throw new Error("encrypted folder was selectable");
        await ev(`(() => { for (const name of ["hello.txt", "folder/item-0.txt"]) {
            const row = [...document.querySelectorAll(".zip-table tbody tr")].find(r => r.querySelector("td.name").textContent === name);
            row.querySelector("input").click();
        } })()`);
        if (!(await ev(`document.querySelector(".zip-select-shown").indeterminate && document.querySelector(".zip-selection-summary").textContent.includes("2 files selected · 12 B")`))) throw new Error("partial selection or size missing");
        await ev(`document.querySelector(".zip-extract-selected").click()`);
        await waitFor(`document.querySelector(".zip-extract-status")?.textContent.includes("Extracted 2 files into media/listing (1)")`, "selected ZIP entries extracted");
        if (inContainer("cat", "/home/user/Downloads/media/listing (1)/hello.txt") !== "hello") throw new Error("selected file missing");
        if (inContainer("cat", "/home/user/Downloads/media/listing/folder/item-649.txt") !== "content") throw new Error("existing extraction overwritten");
        await ev(`document.querySelector(".zip-open-folder").click()`);
        await waitFor(`!document.querySelector("dialog.preview") && ${listed}.includes("hello.txt") && location.hash.includes("listing%20(1)")`, "extracted folder opened");
        await open("fs/#/media/", `${listed}.includes("encoding.zip")`, "ZIP listing again");
        await show("encoding.zip");
        if ((await ev(`document.querySelector(".zip-table tbody td").textContent`)) !== "café.txt") throw new Error("ZIP legacy filename encoding was lost");
        await ev(`(() => { const b = document.querySelector(".zip-filter"); b.value = "café"; b.dispatchEvent(new Event("input")); })()`);
        if ((await ev(`document.querySelectorAll(".zip-table tbody tr").length`)) !== 1) throw new Error("decoded ZIP name wasn't searchable");
        await close();
        await show("empty.zip");
        if (!(await ev(`document.querySelector(".zip-listing").textContent.includes("0 entries")`))) throw new Error("empty ZIP wasn't listed");
        await close();
        await ev(`[...document.querySelectorAll("td.name a")].find((a) => a.textContent === "broken.zip").click()`);
        await waitFor(`document.querySelector("dialog.preview .error")?.textContent.includes("ZIP can't be listed")`, "invalid ZIP error");
        if (!(await ev(`!!document.querySelector("dialog.preview button.download")`))) throw new Error("failed ZIP preview lost Download");
        await close();
        inContainer("sh", "-c", "rm -r ~/Downloads/media/listing '/home/user/Downloads/media/listing (1)' ~/Downloads/media/listing.zip ~/Downloads/media/encoding.zip ~/Downloads/media/empty.zip ~/Downloads/media/broken.zip");
        return "paged and filtered contents, safe filenames, individual and selected extraction, collision handling, empty and invalid archives";
    });
}
