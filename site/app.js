const theme = document.querySelector("#theme");
theme.value = document.documentElement.dataset.theme;
theme.addEventListener("change", () => {
  document.documentElement.dataset.theme = theme.value;
  try {
    if (theme.value === "system") {
      localStorage.removeItem("auditmos-theme");
    } else {
      localStorage.setItem("auditmos-theme", theme.value);
    }
  } catch {
    /* Keep the current selection for this page. */
  }
});

const videos = [...document.querySelectorAll("video")];
for (const gallery of document.querySelectorAll(".track-gallery")) {
  gallery.addEventListener("change", () => {
    for (const video of gallery.querySelectorAll("video")) {
      video.pause();
    }
  });
}
for (const video of videos) {
  video.addEventListener("play", () => {
    for (const other of videos) {
      if (other !== video) {
        other.pause();
      }
    }
  });
  video.addEventListener("error", () => {
    const message = video.closest(".track").querySelector(".media-error");
    message.hidden = false;
  });
}
