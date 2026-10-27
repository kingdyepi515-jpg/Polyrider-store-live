(() => {
  const { $ } = PR;
  function show(mac) {
    $("mac").classList.toggle("hide", !mac); $("win").classList.toggle("hide", mac);
    $("tMac").classList.toggle("on", mac); $("tWin").classList.toggle("on", !mac);
  }
  $("tWin").onclick = () => show(false);
  $("tMac").onclick = () => show(true);
  show(/Mac/i.test(navigator.platform || navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent) || location.hash === "#mac");
})();
