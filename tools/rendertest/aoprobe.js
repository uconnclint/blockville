window.__probe = (cx, cy, n=6) => {
  const E=BV.engine, L=E._lighting, r=E.renderer, cam=E.camera, dom=r.domElement.getBoundingClientRect();
  const ray=E._ray; const ndc = cam.position.clone(); ndc.set((cx-dom.left)/dom.width*2-1, -((cy-dom.top)/dom.height)*2+1, 0);
  ray.setFromCamera(ndc, cam);
  const hits = ray.intersectObjects(E.scene.children, true).filter(h=>h.object.isMesh && h.object.visible && (h.object.castShadow||h.object.receiveShadow));
  if(!hits.length) return 'nohit';
  const h=hits[0]; const p=h.point; const nrm = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
  const rt = (L.uniforms.uAoMap.value === L._aoTarget.texture) ? L._aoTarget : L._aoTargetB;
  const xf=L.uniforms.uAoXf.value, res=L._aoRes;
  const u = p.x*xf.x+xf.y, v=p.z*xf.z+xf.w; const tx=Math.floor(u*res), ty=Math.floor(v*res);
  const W=2*n+1; const buf=new Uint16Array(W*W*4);
  r.readRenderTargetPixels(rt, tx-n, ty-n, W, W, buf);
  const f16=(h)=>{const s=(h&0x8000)?-1:1,e=(h>>10)&31,m=h&1023; return e===0? s*m*Math.pow(2,-24): e===31? NaN : s*Math.pow(2,e-15)*(1+m/1024);};
  const rows={top:[],und:[],flo:[],b:[]};
  for(let j=0;j<W;j++){ const t=[],b=[],g=[],a=[]; for(let i=0;i<W;i++){const k=(j*W+i)*4; t.push((f16(buf[k])-20).toFixed(2)); const G=f16(buf[k+1]); g.push(G>0?(G-20).toFixed(2):(G<0?'e':'-')); const A=f16(buf[k+3]); a.push(A>0?(A-20).toFixed(2):(A<0?'x':'-')); b.push(f16(buf[k+2]).toFixed(2));} rows.top.push(t.join(' ')); rows.b.push(b.join(' ')); rows.und.push(g.join(' ')); rows.flo.push(a.join(' '));}
  return {p:[p.x.toFixed(2),p.y.toFixed(2),p.z.toFixed(2)], nrm: nrm&&nrm.toArray().map(x=>x.toFixed(2)), tx,ty, rows};
};
window.__row = (cx,cy,n=6)=>{const r=__probe(cx,cy,n); if(typeof r==='string') return r; return {p:r.p,nrm:r.nrm, top:r.rows.top[n], und:r.rows.und[n], flo:r.rows.flo[n], b:r.rows.b[n]};};
