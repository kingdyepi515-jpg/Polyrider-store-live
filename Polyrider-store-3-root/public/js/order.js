(() => {
  const { api, $, hashParams } = PR;
  const token = hashParams().t || "";
  let amount = "", cashUrl = "https://cash.app";
  function render(o, note) {
    $("loading").classList.add("hide"); $("app").classList.remove("hide");
    $("oid").textContent=o.id; $("oemail").textContent=o.email;
    $("status").className="status s-"+o.status; $("statusText").textContent=o.statusText;
    const help={awaiting_payment:"Scan the QR code with Cash App's Bitcoin scanner, or open the Cash App link, and pay the exact amount shown. Use the same email you entered here. The seller will manually confirm the payment before issuing your monthly license.",payment_detected:"Payment submitted; please wait for the seller to check it.",payment_confirmed:"Payment checked. Waiting for the seller to issue your license.",requires_review:"The seller is reviewing this order and will contact you by email.",approved:"Your payment was approved. Check your email for your license and download link.",expired:"This order is no longer active. Please contact support.",rejected:"This order was rejected. Contact support if you believe this is a mistake."};
    $("statusHelp").textContent=help[o.status]||""; $("note").textContent=note||""; $("note").classList.toggle("hide",!note);
    const show=o.status==="awaiting_payment"; $("payBox").classList.toggle("hide",!show);
    if(show){$("usd").textContent=(+o.usd).toFixed(2); $("btc1").textContent="$"+(+o.usd).toFixed(2); $("btc2").textContent="$"+(+o.usd).toFixed(2); $("addr").textContent=o.cashAppUrl||o.address; cashUrl=/^https:\/\/cash\.app\//.test(o.cashAppUrl||"")?o.cashAppUrl:"https://cash.app"; amount=(+o.usd).toFixed(2); if(!$("qr").dataset.for){$("qr").innerHTML='<img src="/IMG_8282.jpg" alt="Bitcoin receiving QR code" style="display:block;width:100%;height:auto">';$("qr").dataset.for="img";}}
    $("txBox").classList.add("hide"); $("doneBox").classList.toggle("hide",o.status!=="approved"); $("doneEmail").textContent=o.email;
  }
  async function refresh(){try{render(await api("/api/order/view",{t:token}));}catch(e){if($("loading")){ $("loading").classList.add("hide");$("notFound").classList.remove("hide");$("nfMsg").textContent=e.message;}}}
  if(!token){$("loading").classList.add("hide");$("notFound").classList.remove("hide");return;}
  $("cpAmt").onclick=()=>navigator.clipboard.writeText(amount);
  $("cpAddr").onclick=()=>{const a=document.createElement("a");a.href=cashUrl;a.target="_blank";a.rel="noopener";a.click();};
  $("checkBtn").textContent="Refresh payment status"; $("checkBtn").onclick=refresh;
  refresh(); setInterval(refresh,30000);
})();