// One page carries both languages at once. styles.css hides the inactive .t spans, so the
// choice is made before the first paint; this script only says which one that is, and fills
// the few places markup cannot go: the title, meta text, select options and labels.
(() => {
  const languages = ["pl", "en"];
  const storageKey = "auditmos-language";

  const fromBrowser = () => {
    const tags = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
    for (const tag of tags) {
      const [base] = String(tag).toLowerCase().split("-");
      if (languages.includes(base)) {
        return base;
      }
    }
    return "en";
  };

  const apply = (chosen) => {
    document.documentElement.lang = chosen;
    document.documentElement.dataset.lang = chosen;
    // The Polish original is the element's own content, kept so switching back is lossless.
    for (const node of document.querySelectorAll("[data-en]")) {
      if (node.dataset.pl === undefined) {
        node.dataset.pl = node.tagName === "META" ? node.content : node.textContent;
      }
      const text = chosen === "en" ? node.dataset.en : node.dataset.pl;
      if (node.tagName === "META") {
        node.content = text;
      } else {
        node.textContent = text;
      }
    }
    for (const node of document.querySelectorAll("[data-label-en]")) {
      if (node.dataset.labelPl === undefined) {
        node.dataset.labelPl = node.getAttribute("aria-label") ?? "";
      }
      node.setAttribute(
        "aria-label",
        chosen === "en" ? node.dataset.labelEn : node.dataset.labelPl
      );
    }
  };

  let saved = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {
    /* The browser's own preference still decides. */
  }
  let language = languages.includes(saved) ? saved : fromBrowser();
  apply(language);

  // The head is already parsed; the body's own [data-en] nodes are not.
  document.addEventListener("DOMContentLoaded", () => {
    apply(language);
    const toggle = document.querySelector("#language");
    if (!toggle) {
      return;
    }
    toggle.addEventListener("click", () => {
      language = language === "en" ? "pl" : "en";
      apply(language);
      try {
        localStorage.setItem(storageKey, language);
      } catch {
        /* Keep the choice for this page. */
      }
    });
  });
})();
