const tokenInput = document.getElementById("token");
const baseUrlInput = document.getElementById("baseUrl");
const status = document.getElementById("status");
const saveButton = document.getElementById("saveCurrentTab");

chrome.storage.local.get(["token", "apiBaseUrl"], (result) => {
  tokenInput.value = result.token || "";
  baseUrlInput.value = result.apiBaseUrl || "http://localhost:4000";
});

const persist = () => chrome.storage.local.set({ token: tokenInput.value, apiBaseUrl: baseUrlInput.value });
[tokenInput, baseUrlInput].forEach((element) => element.addEventListener("change", persist));

saveButton.addEventListener("click", async () => {
  persist();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  const response = await fetch(`${baseUrlInput.value}/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenInput.value}`
    },
    body: JSON.stringify({ sourceType: "url", url: tab.url, title: tab.title })
  });

  status.textContent = response.ok ? "Saved to Second Brain AI" : "Save failed";
});
