// Keeps the element picked on each tab until the report is sent, and reopens the popup.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'shipcue:picked' || !sender.tab?.id) return;
  chrome.storage.session.set({ [`picked:${sender.tab.id}`]: msg.element }).then(() => {
    // Chrome 127+ can reopen the popup; older ones show the "click the icon" note instead.
    chrome.action.openPopup?.().catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`picked:${tabId}`));
