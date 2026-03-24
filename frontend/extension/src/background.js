chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["apiBaseUrl"], (result) => {
    if (!result.apiBaseUrl) chrome.storage.local.set({ apiBaseUrl: "http://localhost:4000" });
  });
});
