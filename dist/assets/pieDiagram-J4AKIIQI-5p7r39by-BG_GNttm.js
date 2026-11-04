import{t as e}from"./render-vgngamhb-CESfbJw5.js";import{i as t}from"./render-v1k0dz6v-VufxbB7V.js";import{t as n}from"./render-4bz9j855-_Rj6728_.js";import{o as r}from"./render-BO3vslx6.js";import{i,s as a}from"./render-783ez9e1-Cf11SqwQ.js";import{_ as o,v as s}from"./render-jse1wxv5-C67jEBel.js";import{H as c,J as l,K as u,M as d,T as f,W as p,X as m,k as h,ot as g,x as _}from"./render-70gkbddq-9RRtlafM.js";import{n as v}from"./render-aymmz4jb-jOgVZdLH.js";import{n as y}from"./render-6t932mpd-DsF7k-Jl.js";var b=g.pie,x={sections:new Map,showData:!1,config:b},S=x.sections,C=x.showData,w=structuredClone(b),T=y(()=>structuredClone(w),`getConfig`),E=y(()=>{S=new Map,C=x.showData,m()},`clear`),D=y(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);S.has(e)||(S.set(e,t),v.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),O=y(()=>S,`getSections`),k=y(e=>{C=e},`setShowData`),A=y(()=>C,`getShowData`),j={getConfig:T,clear:E,setDiagramTitle:d,getDiagramTitle:l,setAccTitle:f,getAccTitle:c,setAccDescription:p,getAccDescription:_,addSection:D,getSections:O,setShowData:k,getShowData:A},M=y((t,n)=>{e(t,n),n.setShowData(t.showData),t.sections.map(n.addSection)},`populateDb`),N={parse:y(async e=>{let t=await n(`pie`,e);v.debug(t),M(t,j)},`parse`)},P=y(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),F=y(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return s().value(e=>e.value).sort(null)(n)},`createPieArcs`),I={parser:N,db:j,renderer:{draw:y((e,n,s,c)=>{v.debug(`rendering pie chart
`+e);let l=c.db,d=u(),f=i(l.getConfig(),d.pie),p=r(n),m=p.append(`g`);m.attr(`transform`,`translate(225,225)`);let{themeVariables:g}=d,[_]=a(g.pieOuterStrokeWidth);_??=2;let{legendPosition:y,textPosition:b}=f,x=f.donutHole>0&&f.donutHole<=.9?f.donutHole:0,S=o().innerRadius(x*185).outerRadius(185),C=o().innerRadius(185*b).outerRadius(185*b),w=m.append(`g`);w.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+_/2).attr(`class`,`pieOuterCircle`);let T=l.getSections(),E=F(T),D=[g.pie1,g.pie2,g.pie3,g.pie4,g.pie5,g.pie6,g.pie7,g.pie8,g.pie9,g.pie10,g.pie11,g.pie12],O=0;T.forEach(e=>{O+=e});let k=E.filter(e=>(e.data.value/O*100).toFixed(0)!==`0`),A=t(D).domain([...T.keys()]);w.selectAll(`mySlices`).data(k).enter().append(`path`).attr(`d`,S).attr(`fill`,e=>A(e.data.label)).attr(`class`,e=>{let t=`pieCircle`;return f.highlightSlice===`hover`?t+=` highlightedOnHover`:f.highlightSlice===e.data.label&&(t+=` highlighted`),t}),w.selectAll(`mySlices`).data(k).enter().append(`text`).text(e=>(e.data.value/O*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+C.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let j=m.append(`text`).text(l.getDiagramTitle()).attr(`x`,0).attr(`y`,-200).attr(`class`,`pieTitleText`),M=[...T.entries()].map(([e,t])=>({label:e,value:t})),N=m.selectAll(`.legend`).data(M).enter().append(`g`).attr(`class`,`legend`);N.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>A(e.label)).style(`stroke`,e=>A(e.label)),N.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>l.getShowData()?`${e.label} [${e.value}]`:e.label);let P=Math.max(...N.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),I=450,L=490,R=M.length*22;switch(y){case`center`:N.attr(`transform`,(e,t)=>{let n=22*M.length/2,r=-P/2-22,i=t*22-n;return`translate(`+r+`,`+i+`)`});break;case`top`:I+=R,N.attr(`transform`,(e,t)=>`translate(${-P/2-22}, ${t*22-185})`),w.attr(`transform`,()=>`translate(0, ${R+22})`);break;case`bottom`:I+=R,N.attr(`transform`,(e,t)=>{let n=-P/2-22,r=t*22- -207;return`translate(`+n+`,`+r+`)`});break;case`left`:L+=22+P,N.attr(`transform`,(e,t)=>{let n=22*M.length/2;return`translate(-207,`+(t*22-n)+`)`}),w.attr(`transform`,()=>`translate(${P+18+4}, 0)`);break;default:L+=22+P,N.attr(`transform`,(e,t)=>{let n=22*M.length/2;return`translate(216,`+(t*22-n)+`)`})}let z=j.node()?.getBoundingClientRect().width??0,B=225-z/2,V=225+z/2,H=Math.min(0,B),U=Math.max(L,V)-H;p.attr(`viewBox`,`${H} 0 ${U} ${I}`),h(p,I,U,f.useMaxWidth)},`draw`)},styles:P};export{I as diagram};