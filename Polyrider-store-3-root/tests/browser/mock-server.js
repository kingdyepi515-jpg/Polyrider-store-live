// Stand-in for server.js: same /api contract + same CSP header as helmet config in server.js.
// Usage: node mock-server.js <publicDir> <port> [ready=0|1] [salesOpen=0|1]
const http=require('http'),fs=require('fs'),path=require('path');
const [,,PUB,PORT,READY='1',OPEN='1']=process.argv;
const CSP="default-src 'self';img-src 'self' data:;style-src 'self' 'unsafe-inline';script-src 'self';connect-src 'self';frame-ancestors 'none';form-action 'self';object-src 'none';script-src-attr 'none';base-uri 'self'";
const orders={};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.jpg':'image/jpeg'};
http.createServer((req,res)=>{
  res.setHeader('Content-Security-Policy',CSP);
  const u=req.url.split('?')[0];
  const json=(c,b)=>{res.writeHead(c,{'content-type':'application/json',...{'Content-Security-Policy':CSP}});res.end(JSON.stringify(b))};
  if(u==='/api/store')return json(200,{productName:'PolyRider BTC 5m',priceUsd:10.99,supportEmail:'help@polyrider.test',salesOpen:READY!==undefined&&OPEN==='1',ready:READY==='1',latestVersion:'4.3.0',quoteMinutes:30});
  let body='';req.on('data',d=>body+=d);req.on('end',()=>{
    let b={};try{b=JSON.parse(body||'{}')}catch{}
    if(u==='/api/orders'&&req.method==='POST'){
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email||''))return json(400,{error:'Please enter a valid email address.'});
      if(OPEN!=='1')return json(503,{error:'Sales are paused right now. Please check back soon.'});
      if(READY!=='1')return json(503,{error:'The store is not ready to accept Cash App payments yet. Please check back soon.'});
      const id='PR-'+Math.random().toString(36).slice(2,10).toUpperCase(),token=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+'abcdefghij';
      orders[token]={id,email:b.email.toLowerCase()};global.__n=(global.__n||0)+1;
      return json(200,{id,token});
    }
    if(u==='/api/order/view'&&req.method==='POST'){
      const o=orders[b.t];if(!o)return json(404,{error:"We couldn't find that order. Use the link from your email, or recover it below."});
      return json(200,{id:o.id,email:o.email,status:'awaiting_payment',statusText:'Awaiting payment',usd:10.99,btc:'0',address:'https://cash.app/$trading123/10.99',cashAppUrl:'https://cash.app/$trading123/10.99',bip21:'https://cash.app/$trading123/10.99',paymentMethod:'Cash App',qrSvg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>',emailConfigured:false});
    }
    if(u==='/__orders')return json(200,{n:global.__n||0});
    let f=path.join(PUB,u==='/'?'index.html':u);if(!fs.existsSync(f)&&fs.existsSync(f+'.html'))f+='.html';
    if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream','Content-Security-Policy':CSP});return res.end(fs.readFileSync(f));}
    res.writeHead(404);res.end('nf');
  });
}).listen(+PORT,()=>console.log('mock up',PORT));
