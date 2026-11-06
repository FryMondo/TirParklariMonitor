const RealDate = Date;
const instant = '2026-11-04T09:00:00.000Z';
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return new RealDate(instant).valueOf(); }
};
let requests=0;
globalThis.fetch = async (_url, options) => {
  if (!_url.endsWith('gun=2026-11-04')) throw new Error('Неочікувана дата запиту');
  requests++;
  if (requests===3) { process.emit('SIGINT'); throw new DOMException('Aborted','AbortError'); }
  if (options.signal.aborted) throw new DOMException('Aborted','AbortError');
  const count=requests===1?2:4;
  return new Response(JSON.stringify({gun:'2026-11-04',dilimDakika:30,gunKapasite:17,gunKalan:count,gunAlinabilir:count,sunucuZamani:instant,dilimler:[{baslangicDakika:1020,baslangic:'17:00',bitis:'17:30',kapasite:17,kalan:count,acik:true,kapali:false}]}),{status:200,headers:{'content-type':'application/json'}});
};
