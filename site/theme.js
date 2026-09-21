try {
  const saved = localStorage.getItem("auditmos-theme");
  if (["light", "dark", "system"].includes(saved)) {
    document.documentElement.dataset.theme = saved;
  }
} catch {
  /* System theme still works when storage is unavailable. */
}
