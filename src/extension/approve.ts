/** The "allow this site?" window opened by the background worker for `enable()` (dappApi.ts). */
export {};
const params = new URLSearchParams(location.search);
const origin = params.get("origin") ?? "";
const requestId = params.get("id") ?? "";
document.getElementById("origin")!.textContent = origin || "(unknown site)";

async function answer(approved: boolean): Promise<void> {
    try { await chrome.runtime.sendMessage({ to: "background", type: "dapp-approval", requestId, approved }); } catch { /* the worker restarted: the request is gone */ }
    window.close();
}
document.getElementById("allow")!.addEventListener("click", () => { void answer(true); });
document.getElementById("deny")!.addEventListener("click", () => { void answer(false); });
if (!origin || !requestId) (document.getElementById("allow") as HTMLButtonElement).disabled = true;
