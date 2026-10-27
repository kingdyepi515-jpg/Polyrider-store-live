(() => {
  const { api, $, hashParams } = PR;
  const h = hashParams();
  if (h.e) $("email").value = h.e;
  if (h.k) $("key").value = h.k;
  if (h.e || h.k) history.replaceState(null, "", location.pathname); // don't leave the key in the address bar

  $("dlForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("err").textContent = "";
    $("dlBtn").disabled = true; $("dlBtn").textContent = "Checking your license…";
    try {
      const r = await api("/api/download/request", { email: $("email").value.trim(), key: $("key").value.trim() });
      $("dlLink").href = r.url;
      $("dlLink").textContent = `Download PolyRider v${r.version} (ZIP)`;
      $("relNotes").textContent = r.notes ? "What's new: " + r.notes : "";
      $("ready").classList.remove("hide");
    } catch (err) { $("err").textContent = err.message; }
    $("dlBtn").disabled = false; $("dlBtn").textContent = "Get my download";
  });

  $("recForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("recErr").textContent = ""; $("recOk").classList.add("hide");
    $("recBtn").disabled = true;
    try {
      const r = await api("/api/recover", { email: $("recEmail").value.trim() });
      $("recOk").textContent = r.message; $("recOk").classList.remove("hide");
    } catch (err) { $("recErr").textContent = err.message; }
    $("recBtn").disabled = false;
  });
})();
