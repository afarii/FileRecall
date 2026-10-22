document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;

  const clicked = event.target.closest("a[href], button");
  if (!clicked) return;

  const context = {
    pageUrl: window.location.href,
    pageTitle: document.title,
    linkUrl: clicked.matches("a[href]") ? clicked.href : null,
    clickedText: clicked.textContent.trim(),
    timestamp: new Date().toISOString(),
  };

  try {
    await chrome.runtime.sendMessage({ type: "CLICK_CONTEXT", context });
  } catch (error) {
    console.warn("Could not send click context:", error);
  }
}, true);
