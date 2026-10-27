(() => {
  const { api, $, store } = PR;
  const form = $("orderForm"), btn = $("buyBtn"), err = $("err");
  const BTN_TEXT = btn.textContent.trim();
  let created = false;

  // Only block checkout when it genuinely cannot work (sales paused, or CASH_APP_TAG missing on the server).
  store().then((s) => {
    if (!s.salesOpen || !s.ready) {
      btn.disabled = true;
      err.textContent = s.salesOpen ? "Checkout opens soon — the seller is finishing setup." : "Sales are paused right now. Please check back soon.";
    }
  }).catch(() => {});

  function showPayment(order) {
    created = true;
    const box = $("bitcoin-payment"), qr = $("bitcoin-qr"), status = $("payment-status");
    $("order-created").textContent = "Order " + order.id + " created.";
    $("order-link").href = "/order.html#t=" + encodeURIComponent(order.token);
    box.hidden = false;
    btn.disabled = false; btn.textContent = "Payment instructions shown below";
    box.scrollIntoView({ behavior: "smooth", block: "center" });
    const loaded = () => { status.textContent = "Scan the QR code, then keep your transaction confirmation. Bookmark your order page to check its status."; };
    const failed = () => { status.textContent = "The QR image could not load. Open your order page below, or email the seller."; };
    if (qr.complete) (qr.naturalWidth > 0 ? loaded : failed)();
    else { qr.addEventListener("load", loaded, { once: true }); qr.addEventListener("error", failed, { once: true }); }
  }

  // Submit handler covers BOTH the button click and pressing Enter; it never lets the page reload.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (created) { $("bitcoin-payment").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    const email = $("email").value.trim();
    err.textContent = "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Please enter a valid email address."; $("email").focus(); return; }
    btn.disabled = true; btn.textContent = "Creating your order…";
    try {
      const r = await api("/api/orders", { email });
      showPayment(r);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false; btn.textContent = BTN_TEXT;
    }
  });
})();
