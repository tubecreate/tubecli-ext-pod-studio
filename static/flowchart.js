/**
 * Storyboard Flowchart — Visual Node Graph (v3)
 * Draggable cards, ref image management, layout persistence, media playback
 */
(function () {
    'use strict';
    const API = '/api/v1/studio';
    const COL_X = { ref: 60, char: 260, scene: 540, shot: 820, video: 1120 };
    const ROW_GAP = 24;
    const COLORS = { charA:'hsla(210,80%,55%,0.5)', sceneA:'hsla(30,85%,55%,0.5)', videoA:'hsla(145,65%,45%,0.5)', refA:'hsla(320,70%,55%,0.45)', dim:'hsla(0,0%,30%,0.12)' };

    let overlay=null, canvas=null, ctx=null, nodesLayer=null;
    let selectedEdge = null;
    let zoom=1, panX=0, panY=0;
    let isPanning=false, panSX=0, panSY=0, panOX=0, panOY=0;
    let dragNode=null, dragOX=0, dragOY=0;
    let nodes=[], edges=[], highlightId=null;
    let showChars=true, showScenes=true, showVideos=true;
    let _episodeId=null, _dramaId=null;
    let _saveTimer=null;
    let _curAudio=null, _curAudioBtn=null, _curAudioBar=null, _curAudioAnim=null;

    const _esc=s=>{const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;};
    const charImg=c=>{ if(!c.image_url) return null; if(c.image_url.startsWith('/api/')) return c.image_url; return `${API}/references/${encodeURIComponent(c.image_url.replace(/\\/g,'/').split('/').pop())}`; };
    const sceneImg=s=>s.image_url?`${API}/references/${encodeURIComponent(s.image_url.replace(/\\/g,'/').split('/').pop())}`:null;
    const shotImg=s=>s.composed_image?`${API}/grok-image/${encodeURIComponent(s.composed_image.replace(/\\/g,'/').split('/').pop())}`:null;
    const videoUrl=s=>s.video_url?`${API}/grok-video/${encodeURIComponent(s.video_url.replace(/\\/g,'/').split('/').pop())}`:null;
    const refImgUrl=path=>`${API}/references/${encodeURIComponent(path.replace(/\\/g,'/').split('/').pop())}`;

    /* ── Data ─────────────────────────────────────────── */
    async function fetchData(epId, dramaId) {
        const [sb,ch,sc]=await Promise.all([
            fetch(`${API}/episodes/${epId}/storyboards`).then(r=>r.json()),
            fetch(`${API}/dramas/${dramaId}/characters`).then(r=>r.json()),
            fetch(`${API}/dramas/${dramaId}/scenes`).then(r=>r.json()),
        ]);
        return { shots:sb.items||[], characters:ch.items||ch||[], scenes:sc.items||sc||[] };
    }

    async function loadLayout(epId) {
        try { const r=await fetch(`${API}/episodes/${epId}/flowchart-layout`); const d=await r.json(); return d.layout||{}; } catch(e) { return {}; }
    }

    function saveLayout() {
        if(_saveTimer) clearTimeout(_saveTimer);
        _saveTimer=setTimeout(async()=>{
            if(!_episodeId) return;
            const layout={};
            nodes.forEach(n=>{ layout[n.id]={x:Math.round(n.x),y:Math.round(n.y)}; });
            try { await fetch(`${API}/episodes/${_episodeId}/flowchart-layout`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({layout})}); } catch(e){}
        }, 800);
    }

    /* ── Layout ───────────────────────────────────────── */
    function buildGraph(data, savedLayout) {
        nodes=[]; edges=[];
        const TOP=50;
        const usedC=new Set(), usedS=new Set();
        data.shots.forEach(sh=>{(sh.character_ids||[]).forEach(id=>usedC.add(id));if(sh.scene_id)usedS.add(sh.scene_id);});

        let cy=TOP;
        data.characters.filter(c=>usedC.has(c.id)).forEach(c=>{
            const id=`c_${c.id}`, h=c.image_url?145:70;
            const pos=savedLayout[id];
            nodes.push({id,type:'char',x:pos?.x??COL_X.char,y:pos?.y??cy,w:130,h,data:c}); cy+=h+ROW_GAP;
        });
        let sy=TOP;
        data.scenes.filter(s=>usedS.has(s.id)).forEach(s=>{
            const id=`s_${s.id}`, h=s.image_url?130:65;
            const pos=savedLayout[id];
            nodes.push({id,type:'scene',x:pos?.x??COL_X.scene,y:pos?.y??sy,w:150,h,data:s}); sy+=h+ROW_GAP;
        });
        let shy=TOP;
        data.shots.forEach(sh=>{
            const id=`sh_${sh.id}`;
            const h=(sh.narration_text||sh.dialogue?40:0)+75;
            const pos=savedLayout[id];
            nodes.push({id,type:'shot',x:pos?.x??COL_X.shot,y:pos?.y??shy,w:200,h,data:sh}); shy+=h+ROW_GAP;
        });

        // Ref image nodes (from storyboard reference_images)
        let ry=TOP;
        data.shots.forEach(sh=>{
            let refs=[];
            try { refs=JSON.parse(sh.reference_images||'[]'); } catch(e){}
            refs.forEach((rp,i)=>{
                const rid=`r_${sh.id}_${i}`, pos=savedLayout[rid];
                nodes.push({id:rid,type:'ref',x:pos?.x??COL_X.ref,y:pos?.y??ry,w:120,h:110,data:{path:rp,shotId:sh.id,index:i}});
                edges.push({from:rid,to:`sh_${sh.id}`,type:'ref'});
                ry+=110+ROW_GAP;
            });
        });

        let vy=TOP;
        data.shots.filter(s=>s.video_url).forEach(sh=>{
            const id=`v_${sh.id}`, pos=savedLayout[id];
            nodes.push({id,type:'video',x:pos?.x??COL_X.video,y:pos?.y??vy,w:170,h:160,data:sh}); vy+=160+ROW_GAP;
        });

        // Edges
        data.shots.forEach(sh=>{
            (sh.character_ids||[]).forEach(cid=>{ if(nodes.find(n=>n.id===`c_${cid}`)) edges.push({from:`c_${cid}`,to:`sh_${sh.id}`,type:'char'}); });
            if(sh.scene_id&&nodes.find(n=>n.id===`s_${sh.scene_id}`)) edges.push({from:`s_${sh.scene_id}`,to:`sh_${sh.id}`,type:'scene'});
            if(sh.video_url) edges.push({from:`sh_${sh.id}`,to:`v_${sh.id}`,type:'video'});
        });
    }

    /* ── Render Nodes ─────────────────────────────────── */
    function renderNodes() {
        nodesLayer.innerHTML='';
        [{x:COL_X.ref,l:'🖼️ Extra Refs'},{x:COL_X.char,l:'👤 Characters'},{x:COL_X.scene,l:'📍 Scenes'},{x:COL_X.shot,l:'🎬 Shots'},{x:COL_X.video,l:'🎥 Videos'}].forEach(h=>{
            const el=document.createElement('div');el.className='fc-col-header';el.style.left=h.x+'px';el.textContent=h.l;nodesLayer.appendChild(el);
        });
        for(const n of nodes) {
            if(n.type==='char'&&!showChars) continue;
            if(n.type==='scene'&&!showScenes) continue;
            if(n.type==='video'&&!showVideos) continue;
            const el=document.createElement('div');
            el.className=`fc-node fc-node--${n.type}`;
            el.style.cssText=`left:${n.x}px;top:${n.y}px;width:${n.w}px;`;
            el.dataset.nodeId=n.id;
            el.innerHTML=buildNodeHTML(n);
            el.addEventListener('mousedown',e=>{
                if(e.target.closest('button,audio,video,a,input,textarea')) return;
                e.stopPropagation();
                dragNode=n; dragOX=(e.clientX-panX)/zoom-n.x; dragOY=(e.clientY-panY)/zoom-n.y;
            });
            el.addEventListener('click',e=>{
                if(e.target.closest('button,audio,video,a,input,textarea,.fc-video-wrapper')) return;
                // Collapse all other expanded nodes
                nodesLayer.querySelectorAll('.fc-node.fc-expanded').forEach(x=>{ if(x!==el) x.classList.remove('fc-expanded'); });
                // Toggle this node
                el.classList.toggle('fc-expanded');
                highlightId=el.classList.contains('fc-expanded')?n.id:null;
                render();
            });
            nodesLayer.appendChild(el);
        }
        initVideoPlayers();
    }

    function initVideoPlayers() {
        nodesLayer.querySelectorAll('.fc-video-wrapper video').forEach(vid => {
            const wrap = vid.closest('.fc-video-wrapper');
            const fill = wrap.querySelector('.fc-video-progress-fill');
            const btn = wrap.querySelector('.fc-video-play-btn');
            vid.ontimeupdate = () => {
                if(!vid.duration) return;
                const pct = (vid.currentTime / vid.duration) * 100;
                if(fill) fill.style.width = pct + '%';
            };
            vid.onplay = () => { if(btn) btn.style.opacity = '0'; };
            vid.onpause = () => { if(btn) btn.style.opacity = '1'; };
            vid.onended = () => { if(btn) btn.style.opacity = '1'; };
        });
    }

    function buildNodeHTML(n) {
        let h='';
        if(n.type==='char') {
            const url=charImg(n.data);
            h+=url?`<img class="fc-node-img" src="${url}" style="height:100px" loading="lazy">`:`<div class="fc-node-img-placeholder" style="height:60px">👤</div>`;
            h+=`<span class="fc-badge fc-badge--char">${_esc(n.data.role||'char')}</span>`;
            h+=`<div class="fc-node-body"><div class="fc-node-title">${_esc(n.data.name)}</div></div>`;
            h+=`<div class="fc-anchor fc-anchor--out fc-anchor--char"></div>`;
        } else if(n.type==='scene') {
            const url=sceneImg(n.data);
            h+=url?`<img class="fc-node-img" src="${url}" style="height:90px" loading="lazy">`:`<div class="fc-node-img-placeholder" style="height:50px">📍</div>`;
            h+=`<span class="fc-badge fc-badge--scene">scene</span>`;
            h+=`<div class="fc-node-body"><div class="fc-node-title">${_esc(n.data.location||'?')}</div><div class="fc-node-subtitle">${_esc(n.data.time||'')}</div></div>`;
            h+=`<div class="fc-anchor fc-anchor--out fc-anchor--scene"></div>`;
        } else if(n.type==='ref') {
            const url=refImgUrl(n.data.path);
            h+=`<img class="fc-node-img" src="${url}" style="height:80px" loading="lazy">`;
            h+=`<span class="fc-badge fc-badge--ref">ref</span>`;
            h+=`<div class="fc-node-body">`;
            h+=`<div class="fc-node-subtitle">→ Shot #${n.data.shotId}</div>`;
            h+=`<div class="fc-actions" style="margin-top:6px"><button class="fc-act-btn fc-act-btn--danger" onclick="window._fcDeleteRef(${n.data.shotId}, ${n.data.index})">🗑️ Delete</button></div>`;
            h+=`</div>`;
            h+=`<div class="fc-anchor fc-anchor--out fc-anchor--ref"></div>`;
        } else if(n.type==='shot') {
            const sh=n.data;
            h+=`<span class="fc-badge fc-badge--shot">#${sh.storyboard_number||'?'}</span>`;
            if(!sh.scene_id) h+=`<span class="fc-badge fc-badge--warn" style="top:auto;bottom:6px;right:6px">⚠️</span>`;
            h+=`<div class="fc-node-body" style="padding-top:6px">`;
            h+=`<div class="fc-node-title">${_esc((sh.title||'').substring(0,40))}</div>`;
            h+=`<div class="fc-node-prompt">${_esc((sh.image_prompt||'').substring(0,100))}</div>`;
            const narr=(sh.narration_text||sh.dialogue||'').trim();
            if(narr) h+=`<div class="fc-narration">🗣️ ${_esc(narr.substring(0,80))}${narr.length>80?'…':''}</div>`;
            
            h+=`<div class="fc-edit-area">`;
            h+=`<label>Image Prompt</label><textarea class="fc-ta-prompt" onchange="window._fcSaveShot(${sh.id}, 'image_prompt', this.value)">${_esc(sh.image_prompt||'')}</textarea>`;
            h+=`<label>Video Prompt</label><textarea class="fc-ta-prompt" onchange="window._fcSaveShot(${sh.id}, 'video_prompt', this.value)">${_esc(sh.video_prompt||'')}</textarea>`;
            const narrField = sh.narration_text ? 'narration_text' : 'dialogue';
            h+=`<label>Narration / Dialogue</label><textarea class="fc-ta-narration" onchange="window._fcSaveShot(${sh.id}, '${narrField}', this.value)">${_esc(narr)}</textarea>`;
            h+=`</div>`;
            h+=`<div class="fc-actions">`;
            if(sh.tts_audio_url&&sh.tts_audio_url.trim()) {
                h+=`<button class="fc-act-btn" onclick="window._fcToggleAudio(this, '${sh.tts_audio_url}')" title="Play Audio">▶️ Audio</button>`;
            }
            h+=`<button class="fc-act-btn" onclick="window._fcGenImage(${sh.id}, this)" title="Generate Screen Image">🖼️ Screen</button>`;
            h+=`<button class="fc-act-btn" onclick="window._fcAddRef(${sh.id})" title="Add ref image">🖼️ Ref+</button>`;
            h+=`<button class="fc-act-btn" onclick="window._fcRegenVideo(${sh.id}, this)" title="Regen video">🔄 Video</button>`;
            h+=`</div>`;
            if(sh.tts_audio_url&&sh.tts_audio_url.trim()) {
                h+=`<div class="fc-audio-bar" style="display:none;"><div class="fc-audio-progress"></div></div>`;
            }
            h+=`</div>`;
            h+=`<div class="fc-anchor fc-anchor--in fc-anchor--shot"></div><div class="fc-anchor fc-anchor--out fc-anchor--shot"></div>`;
        } else if(n.type==='video') {
            const sh=n.data, vUrl=videoUrl(sh);
            if(vUrl) {
                h+=`<div class="fc-video-wrapper" onclick="window._fcToggleVideo(this)" style="position:relative; width:100%; height:90px; cursor:pointer; overflow:hidden; border-top-left-radius:8px; border-top-right-radius:8px; background:#000;">
                        <video class="fc-node-video" src="${vUrl}" preload="metadata" muted playsinline loop style="width:100%; height:100%; object-fit:cover; display:block;"></video>
                        <div class="fc-video-play-btn" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); width:40px; height:40px; background:hsla(0,0%,0%,0.6); border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; pointer-events:none; transition:opacity 0.2s;">
                            <svg viewBox="0 0 24 24" fill="currentColor" style="width:20px; height:20px; margin-left:3px;"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                        <div class="fc-video-progress-bg" style="position:absolute; bottom:0; left:0; width:100%; height:4px; background:hsla(0,0%,100%,0.3);">
                            <div class="fc-video-progress-fill" style="height:100%; width:0%; background:hsl(210,80%,65%); transition:width 0.1s linear;"></div>
                        </div>
                    </div>`;
            } else {
                h+=`<div class="fc-node-img-placeholder" style="height:90px">🎥</div>`;
            }
            h+=`<span class="fc-badge fc-badge--video">#${sh.storyboard_number||'?'}</span>`;
            h+=`<div class="fc-node-body"><div class="fc-node-title">Shot #${sh.storyboard_number||'?'}</div>`;
            h+=`<div class="fc-node-subtitle">${sh.video_url?'✅ Done':'⏳'}</div></div>`;
            h+=`<div class="fc-anchor fc-anchor--in fc-anchor--video"></div>`;
        }
        return h;
    }

    /* ── Canvas ───────────────────────────────────────── */
    window.addEventListener('resize',()=>{
        if(canvas&&canvas.parentElement) {
            canvas.width=canvas.parentElement.clientWidth;
            canvas.height=canvas.parentElement.clientHeight;
            render();
        }
    });

    window.addEventListener('keydown', e => {
        if((e.key==='Delete'||e.key==='Backspace') && selectedEdge) {
            if(document.activeElement && (document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA')) return;
            window._fcDeleteEdge(selectedEdge);
            selectedEdge = null;
            render();
        }
    });

    function renderEdges() {
        canvas.width=canvas.parentElement.clientWidth;
        canvas.height=canvas.parentElement.clientHeight;
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.save(); ctx.translate(panX,panY); ctx.scale(zoom,zoom);
        // Draw normal edges first
        for(const e of edges) {
            if(e===selectedEdge) continue;
            const fN=nodes.find(n=>n.id===e.from), tN=nodes.find(n=>n.id===e.to);
            if(!fN||!tN) continue;
            let dim=highlightId && (fN.id!==highlightId && tN.id!==highlightId);
            let color = 'hsla(0, 0%, 50%, 0.4)';
            if(!dim) {
                if(e.type==='char') color='hsla(210, 80%, 55%, 0.6)';
                else if(e.type==='scene') color='hsla(30, 85%, 55%, 0.6)';
                else if(e.type==='shot') color='hsla(270, 60%, 60%, 0.6)';
                else if(e.type==='video') color='hsla(145, 65%, 45%, 0.6)';
                else if(e.type==='ref') color='hsla(320, 70%, 55%, 0.6)';
            }
            ctx.beginPath();
            const x1=fN.x+fN.w, y1=fN.y+fN.h/2, x2=tN.x, y2=tN.y+tN.h/2;
            ctx.moveTo(x1,y1); ctx.bezierCurveTo((x1+x2)/2,y1,(x1+x2)/2,y2,x2,y2);
            ctx.strokeStyle=color; ctx.lineWidth=dim?1:2; ctx.stroke();
        }
        // Draw selected edge on top
        if(selectedEdge) {
            const e = selectedEdge;
            const fN=nodes.find(n=>n.id===e.from), tN=nodes.find(n=>n.id===e.to);
            if(fN && tN) {
                let color = 'hsl(0, 0%, 100%)';
                if(e.type==='char') color='hsl(210, 100%, 75%)';
                else if(e.type==='scene') color='hsl(30, 100%, 70%)';
                else if(e.type==='ref') color='hsl(320, 100%, 75%)';
                ctx.beginPath();
                const x1=fN.x+fN.w, y1=fN.y+fN.h/2, x2=tN.x, y2=tN.y+tN.h/2;
                ctx.moveTo(x1,y1); ctx.bezierCurveTo((x1+x2)/2,y1,(x1+x2)/2,y2,x2,y2);
                ctx.strokeStyle=color; ctx.lineWidth=3; 
                ctx.shadowColor = color; ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('×', midX, midY+1);
            }
        }
        ctx.restore();
    }

    function render() {
        nodesLayer.style.transform=`translate(${panX}px,${panY}px) scale(${zoom})`;
        renderEdges();
        const els=nodesLayer.querySelectorAll('.fc-node');
        if(highlightId) {
            const conn=new Set([highlightId]);
            edges.forEach(e=>{ if(e.from===highlightId) conn.add(e.to); if(e.to===highlightId) conn.add(e.from); });
            els.forEach(el=>{ el.classList.toggle('fc-dimmed',!conn.has(el.dataset.nodeId)); el.classList.toggle('fc-highlighted',el.dataset.nodeId===highlightId); });
        } else { els.forEach(el=>el.classList.remove('fc-dimmed','fc-highlighted')); }
    }

    /* ── Interaction ──────────────────────────────────── */
    function initInteraction(wrap) {
        wrap.addEventListener('mousedown',e=>{
            if(e.target.closest('.fc-node')) return;
            isPanning=true; panSX=e.clientX; panSY=e.clientY; panOX=panX; panOY=panY;
        });
        window.addEventListener('mousemove',e=>{
            if(dragNode) {
                dragNode.x=(e.clientX-panX)/zoom-dragOX;
                dragNode.y=(e.clientY-panY)/zoom-dragOY;
                const el=nodesLayer.querySelector(`[data-node-id="${dragNode.id}"]`);
                if(el){el.style.left=dragNode.x+'px';el.style.top=dragNode.y+'px';}
                renderEdges(); return;
            }
            if(!isPanning) return;
            panX=panOX+(e.clientX-panSX); panY=panOY+(e.clientY-panSY); render();
        });
        window.addEventListener('mouseup',()=>{ if(dragNode) saveLayout(); isPanning=false; dragNode=null; });
        wrap.addEventListener('wheel',e=>{
            if(e.target.closest('textarea')) return; // Allow normal scrolling inside textareas
            e.preventDefault();
            const r=wrap.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
            const old=zoom; zoom=Math.max(0.15,Math.min(3,zoom*(e.deltaY>0?0.9:1.1)));
            panX=mx-(mx-panX)*(zoom/old); panY=my-(my-panY)*(zoom/old);
            updateZoom(); render();
        },{passive:false});
        wrap.addEventListener('click',e=>{ 
            if(e.target.closest('.fc-node')) return;
            const r=canvas.getBoundingClientRect();
            const cx=(e.clientX-r.left-panX)/zoom, cy=(e.clientY-r.top-panY)/zoom;
            let clickedEdge = null;
            
            const getBezierPt = (t,x1,y1,cx1,cy1,cx2,cy2,x2,y2) => {
                const u=1-t, tt=t*t, uu=u*u, uuu=uu*u, ttt=tt*t;
                return {x: uuu*x1 + 3*uu*t*cx1 + 3*u*tt*cx2 + ttt*x2, y: uuu*y1 + 3*uu*t*cy1 + 3*u*tt*cy2 + ttt*y2};
            };
            
            for(const ed of edges) {
                if(ed.type!=='char' && ed.type!=='scene' && ed.type!=='ref') continue;
                const fN=nodes.find(n=>n.id===ed.from), tN=nodes.find(n=>n.id===ed.to);
                if(!fN||!tN) continue;
                const x1=fN.x+fN.w, y1=fN.y+fN.h/2, x2=tN.x, y2=tN.y+tN.h/2;
                const mx=(x1+x2)/2;
                // Check 5 points along the bezier curve
                const pts = [
                    {x:x1,y:y1},
                    getBezierPt(0.25, x1,y1, mx,y1, mx,y2, x2,y2),
                    {x:mx, y:(y1+y2)/2},
                    getBezierPt(0.75, x1,y1, mx,y1, mx,y2, x2,y2),
                    {x:x2,y:y2}
                ];
                let hit=false;
                for(const p of pts) {
                    if(Math.hypot(cx-p.x, cy-p.y) < 15) {hit=true;break;}
                }
                if(hit) { clickedEdge = ed; break; }
            }
            if(clickedEdge) {
                selectedEdge = clickedEdge;
                highlightId = null; nodesLayer.querySelectorAll('.fc-expanded').forEach(x=>x.classList.remove('fc-expanded'));
                render();
            } else {
                selectedEdge = null;
                highlightId = null; nodesLayer.querySelectorAll('.fc-expanded').forEach(x=>x.classList.remove('fc-expanded'));
                render();
            }
        });
    }

    function updateZoom(){const el=overlay?.querySelector('.fc-zoom-label');if(el)el.textContent=Math.round(zoom*100)+'%';}

    /* ── Actions ──────────────────────────────────────── */
    window._fcSaveShot=async function(shotId, field, val){
        try {
            await fetch(`${API}/storyboards/${shotId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: val })
            });
            const n = nodes.find(x=>x.id===`sh_${shotId}`);
            if(n) n.data[field] = val; // update local data
            if(typeof toast==='function') toast('Saved successfully','success');
        } catch(err) {
            if(typeof toast==='function') toast('Failed to save: '+err.message,'error');
        }
    };

    window._fcToggleVideo=function(wrap) {
        const vid = wrap.querySelector('video');
        if(!vid) return;
        if(vid.paused) vid.play();
        else vid.pause();
    };

    window._fcToggleAudio=function(btn, url) {
        const nodeBody = btn.closest('.fc-node-body');
        const bar = nodeBody.querySelector('.fc-audio-bar');
        const prog = bar.querySelector('.fc-audio-progress');

        if (_curAudio && _curAudio.src.endsWith(url)) {
            if (_curAudio.paused) { _curAudio.play(); btn.innerHTML='⏸️ Audio'; }
            else { _curAudio.pause(); btn.innerHTML='▶️ Audio'; }
            return;
        }
        if (_curAudio) {
            _curAudio.pause();
            if(_curAudioBtn) _curAudioBtn.innerHTML='▶️ Audio';
            if(_curAudioBar) _curAudioBar.style.display='none';
            cancelAnimationFrame(_curAudioAnim);
        }
        _curAudio = new Audio(url);
        _curAudioBtn = btn;
        _curAudioBar = bar;
        bar.style.display = 'block';
        btn.innerHTML = '⏳ Load';
        _curAudio.onplaying = () => {
            btn.innerHTML = '⏸️ Audio';
            const update = () => {
                if(!_curAudio) return;
                const pct = (_curAudio.currentTime / _curAudio.duration) * 100;
                prog.style.width = (pct||0) + '%';
                _curAudioAnim = requestAnimationFrame(update);
            };
            update();
        };
        _curAudio.onpause = () => { btn.innerHTML = '▶️ Audio'; };
        _curAudio.onended = () => {
            btn.innerHTML = '▶️ Audio';
            bar.style.display = 'none';
            prog.style.width = '0%';
        };
        _curAudio.play().catch(e=> {
            if(typeof toast==='function') toast('Audio play failed','error');
            btn.innerHTML = '▶️ Audio';
            bar.style.display = 'none';
        });
    };

    window._fcAddRef=async function(shotId){
        const input=document.createElement('input');input.type='file';input.accept='image/*';
        input.onchange=async()=>{
            if(!input.files[0]) return;
            const fd=new FormData(); fd.append('file',input.files[0]);
            try {
                const res=await fetch(`${API}/storyboards/${shotId}/upload-ref`,{method:'POST',body:fd});
                const j=await res.json();
                if(j.ok) {
                    if(typeof toast==='function') toast(`Ref added (${j.total_refs} total)`,'success');
                    await reloadFlowchart();
                }
            } catch(err){ if(typeof toast==='function') toast('Upload failed: '+err.message,'error'); }
        };
        input.click();
    };

    window._fcDeleteRef=async function(shotId, idx){
        if(!confirm('Xoá ảnh tham chiếu (Extra Ref) này?')) return;
        const n = nodes.find(x=>x.id===`sh_${shotId}`);
        if(!n) return;
        let refs = [];
        try{refs=JSON.parse(n.data.reference_images||'[]');}catch(e){}
        refs.splice(idx, 1);
        try {
            await fetch(`${API}/storyboards/${shotId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference_images: JSON.stringify(refs) })
            });
            n.data.reference_images = JSON.stringify(refs);
            reloadFlowchart();
            if(typeof toast==='function') toast('Đã xoá ảnh Ref','success');
        } catch(e) {
            if(typeof toast==='function') toast('Xoá thất bại','error');
        }
    };

    window._fcDeleteEdge=async function(ed){
        const fN=nodes.find(n=>n.id===ed.from), tN=nodes.find(n=>n.id===ed.to);
        if(!fN||!tN) return;
        
        if(ed.type==='char') {
            const shot = tN.data;
            let cids = shot.character_ids || [];
            if(typeof cids==='string') {try{cids=JSON.parse(cids);}catch(e){cids=[];}}
            cids = cids.filter(id => id !== fN.data.id);
            try {
                await fetch(`${API}/storyboards/${shot.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({character_ids: JSON.stringify(cids)})});
                tN.data.character_ids = cids;
                reloadFlowchart();
                if(typeof toast==='function') toast('Đã ngắt liên kết Character','success');
            }catch(e){}
        } else if(ed.type==='scene') {
            const shot = tN.data;
            try {
                await fetch(`${API}/storyboards/${shot.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({scene_id: null})});
                tN.data.scene_id = null;
                reloadFlowchart();
                if(typeof toast==='function') toast('Đã ngắt liên kết Scene','success');
            }catch(e){}
        } else if(ed.type==='ref') {
            window._fcDeleteRef(tN.data.id, fN.data.index, true); // true = bypass confirm since edge delete is explicit
        }
    };

    window._fcRegenVideo=async function(shotId, btn){
        if(btn.dataset.taskId) {
            const taskId = btn.dataset.taskId;
            try {
                await fetch(`${API}/gen-videos/cancel/${taskId}`, {method:'POST'});
                if(typeof toast==='function') toast('Đã gửi yêu cầu dừng...','info');
            }catch(e){}
            btn.innerHTML = '🔄 Video';
            btn.style.color = '';
            delete btn.dataset.taskId;
            return;
        }

        if(!confirm('Bạn có muốn mở browser để render lại video cho shot này không?')) return;

        const drama=window._fc_getDrama?.();
        if(!drama||!_episodeId) return;
        let profile='';
        try{const m=JSON.parse(drama.metadata||'{}');profile=m.browser_profile_name||'';}catch(e){}
        if(!profile) profile=localStorage.getItem('cs_last_browser_profile')||'';
        if(!profile){if(typeof toast==='function') toast('No browser profile','error');return;}
        let engine='grok';
        try{const m=JSON.parse(drama.metadata||'{}');engine=m.video_engine||'grok';}catch(e){}
        try{
            btn.innerHTML = '⏳...';
            const res = await fetch(`${API}/episodes/${_episodeId}/gen-videos`,{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({profile_names:[profile],engine,overwrite:true,shot_ids:[shotId]})});
            const j = await res.json();
            if(j.success && j.task_id) {
                if(typeof toast==='function') toast('Đang bắt đầu xử lý video...','success');
                btn.innerHTML = '⏹️ Stop';
                btn.style.color = '#ff6b6b';
                btn.dataset.taskId = j.task_id;
                
                // Poll status to revert button when done
                const poll = setInterval(async()=>{
                    try{
                        const r=await fetch(`${API}/gen-videos/status/${j.task_id}`);
                        const s=await r.json();
                        if(!s.success || s.status === 'done' || s.status.startsWith('error')) {
                            clearInterval(poll);
                            if(btn.dataset.taskId === j.task_id) {
                                btn.innerHTML = '🔄 Video';
                                btn.style.color = '';
                                delete btn.dataset.taskId;
                            }
                            if(s.status==='done') reloadFlowchart();
                        }
                    }catch(e){
                        clearInterval(poll);
                        if(btn.dataset.taskId === j.task_id) {
                            btn.innerHTML = '🔄 Video';
                            btn.style.color = '';
                            delete btn.dataset.taskId;
                        }
                    }
                }, 5000);
            } else {
                btn.innerHTML = '🔄 Video';
            }
        }catch(err){
            if(typeof toast==='function') toast('Lỗi: '+err.message,'error');
            btn.innerHTML = '🔄 Video';
        }
    };

    window._fcGenImage=async function(shotId, btn){
        if(btn.dataset.taskId) {
            const taskId = btn.dataset.taskId;
            try {
                await fetch(`${API}/gen-images/cancel/${taskId}`, {method:'POST'});
                if(typeof toast==='function') toast('Đã gửi yêu cầu dừng...','info');
            }catch(e){}
            btn.innerHTML = '🖼️ Screen';
            btn.style.color = '';
            delete btn.dataset.taskId;
            return;
        }

        const drama=window._fc_getDrama?.();
        if(!drama||!_episodeId) return;
        let profile='';
        try{const m=JSON.parse(drama.metadata||'{}');profile=m.browser_profile_name||'';}catch(e){}
        if(!profile) profile=localStorage.getItem('cs_last_browser_profile')||'';
        if(!profile){if(typeof toast==='function') toast('No browser profile','error');return;}
        
        try{
            btn.innerHTML = '⏳...';
            const res = await fetch(`${API}/episodes/${_episodeId}/gen-images`,{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({profile_name:profile, overwrite:true, shot_ids:[shotId]})});
            const j = await res.json();
            if(j.success && j.task_id) {
                if(typeof toast==='function') toast('Đang tạo Screen Graphic...','success');
                btn.innerHTML = '⏹️ Stop';
                btn.style.color = '#ff6b6b';
                btn.dataset.taskId = j.task_id;
                
                const poll = setInterval(async()=>{
                    try{
                        const r=await fetch(`${API}/gen-images/status/${j.task_id}`);
                        const s=await r.json();
                        if(!s.success || s.status === 'done' || s.status.startsWith('error')) {
                            clearInterval(poll);
                            if(btn.dataset.taskId === j.task_id) {
                                btn.innerHTML = '🖼️ Screen';
                                btn.style.color = '';
                                delete btn.dataset.taskId;
                            }
                            if(s.status==='done') reloadFlowchart();
                        }
                    }catch(e){
                        clearInterval(poll);
                        if(btn.dataset.taskId === j.task_id) {
                            btn.innerHTML = '🖼️ Screen';
                            btn.style.color = '';
                            delete btn.dataset.taskId;
                        }
                    }
                }, 5000);
            } else {
                btn.innerHTML = '🖼️ Screen';
            }
        }catch(err){
            if(typeof toast==='function') toast('Lỗi: '+err.message,'error');
            btn.innerHTML = '🖼️ Screen';
        }
    };

    async function reloadFlowchart(){
        if(!_episodeId||!_dramaId) return;
        const data=await fetchData(_episodeId,_dramaId);
        const layout=await loadLayout(_episodeId);
        buildGraph(data,layout); renderNodes(); updateStats(data); render();
    }

    /* ── Overlay ──────────────────────────────────────── */
    function createOverlay(){
        if(overlay){overlay.remove();overlay=null;}
        const div=document.createElement('div');div.className='flowchart-overlay';
        div.innerHTML=`
            <div class="fc-toolbar">
                <div class="fc-toolbar-title"><span class="fc-icon">🔗</span> Storyboard Flowchart</div>
                <div class="fc-toolbar-sep"></div>
                <div class="fc-toolbar-zoom">
                    <button id="fcZoomOut">−</button><span class="fc-zoom-label">100%</span><button id="fcZoomIn">+</button>
                    <button id="fcZoomFit" title="Fit">⊞</button>
                </div>
                <div class="fc-toolbar-sep"></div>
                <div class="fc-toolbar-filters">
                    <label><input type="checkbox" id="fcShowChars" checked> Chars</label>
                    <label><input type="checkbox" id="fcShowScenes" checked> Scenes</label>
                    <label><input type="checkbox" id="fcShowVideos" checked> Videos</label>
                </div>
                <div class="fc-toolbar-stats" id="fcStats"></div>
                <button class="fc-close-btn" id="fcClose">✕</button>
            </div>
            <div class="fc-canvas-wrap" id="fcCanvasWrap">
                <canvas id="fcCanvas"></canvas>
                <div class="fc-nodes-layer" id="fcNodesLayer"></div>
                <div class="fc-legend">
                    <div class="fc-legend-item"><div class="fc-legend-line fc-legend-line--char"></div>Char</div>
                    <div class="fc-legend-item"><div class="fc-legend-line fc-legend-line--scene"></div>Scene</div>
                    <div class="fc-legend-item"><div class="fc-legend-line fc-legend-line--ref"></div>Ref</div>
                    <div class="fc-legend-item"><div class="fc-legend-line fc-legend-line--video"></div>Video</div>
                </div>
            </div>`;
        document.body.appendChild(div);
        overlay=div; canvas=div.querySelector('#fcCanvas'); ctx=canvas.getContext('2d'); nodesLayer=div.querySelector('#fcNodesLayer');
        div.querySelector('#fcClose').onclick=closeFlowchart;
        div.querySelector('#fcZoomIn').onclick=()=>{zoom=Math.min(3,zoom*1.15);updateZoom();render();};
        div.querySelector('#fcZoomOut').onclick=()=>{zoom=Math.max(0.15,zoom*0.85);updateZoom();render();};
        div.querySelector('#fcZoomFit').onclick=fitToScreen;
        div.querySelector('#fcShowChars').onchange=e=>{showChars=e.target.checked;renderNodes();render();};
        div.querySelector('#fcShowScenes').onchange=e=>{showScenes=e.target.checked;renderNodes();render();};
        div.querySelector('#fcShowVideos').onchange=e=>{showVideos=e.target.checked;renderNodes();render();};
        const onKey=e=>{if(e.key==='Escape')closeFlowchart();};
        document.addEventListener('keydown',onKey); div._onKey=onKey;
        initInteraction(div.querySelector('#fcCanvasWrap'));
        window.addEventListener('resize',renderEdges);
    }

    function updateStats(data){
        const el=overlay?.querySelector('#fcStats');if(!el)return;
        const vc=data.shots.filter(s=>s.video_url).length;
        const rc=data.shots.reduce((t,s)=>{try{return t+JSON.parse(s.reference_images||'[]').length;}catch(e){return t;}},0);
        const ac=data.shots.filter(s=>s.tts_audio_url&&s.tts_audio_url.trim()).length;
        el.innerHTML=`
            <span class="fc-stat"><span class="fc-stat-dot fc-stat-dot--char"></span>${data.characters.length}</span>
            <span class="fc-stat"><span class="fc-stat-dot fc-stat-dot--scene"></span>${data.scenes.length}</span>
            <span class="fc-stat"><span class="fc-stat-dot fc-stat-dot--shot"></span>${data.shots.length}</span>
            <span class="fc-stat" style="color:hsl(320,70%,65%)">🖼️${rc}</span>
            <span class="fc-stat"><span class="fc-stat-dot fc-stat-dot--video"></span>${vc}</span>
            <span class="fc-stat">🔊${ac}</span>`;
    }

    function fitToScreen(){
        if(!nodes.length)return;
        const wrap=overlay?.querySelector('#fcCanvasWrap');if(!wrap)return;
        let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
        nodes.forEach(n=>{x0=Math.min(x0,n.x);y0=Math.min(y0,n.y);x1=Math.max(x1,n.x+n.w);y1=Math.max(y1,n.y+n.h);});
        const gw=x1-x0+100,gh=y1-y0+100;
        zoom=Math.max(0.15,Math.min(1.5,Math.min(wrap.clientWidth/gw,wrap.clientHeight/gh)));
        panX=(wrap.clientWidth-gw*zoom)/2-x0*zoom+50*zoom;
        panY=(wrap.clientHeight-gh*zoom)/2-y0*zoom+50*zoom;
        updateZoom();render();
    }

    /* ── Public ───────────────────────────────────────── */
    async function openFlowchart(){
        const ep=window._fc_getEpisode?.(), drama=window._fc_getDrama?.();
        if(!ep||!drama){if(typeof toast==='function') toast('Select an episode first','error');return;}
        _episodeId=ep.id; _dramaId=drama.id;
        createOverlay();
        requestAnimationFrame(()=>overlay.classList.add('visible'));
        nodesLayer.innerHTML='<div class="fc-empty"><div class="fc-empty-icon">⏳</div><div class="fc-empty-text">Loading...</div></div>';
        try{
            const [data,layout]=await Promise.all([fetchData(ep.id,drama.id),loadLayout(ep.id)]);
            if(!data.shots.length){nodesLayer.innerHTML='<div class="fc-empty"><div class="fc-empty-icon">📋</div><div class="fc-empty-text">No storyboard shots.</div></div>';return;}
            buildGraph(data,layout); renderNodes(); updateStats(data); fitToScreen();
        }catch(e){console.error('[FC]',e);nodesLayer.innerHTML=`<div class="fc-empty"><div class="fc-empty-icon">❌</div><div class="fc-empty-text">${e.message}</div></div>`;}
    }

    function closeFlowchart(){
        if(!overlay)return;
        if(_curAudio){ _curAudio.pause(); _curAudio=null; cancelAnimationFrame(_curAudioAnim); }
        saveLayout(); // persist positions before closing
        overlay.classList.remove('visible');
        setTimeout(()=>{if(overlay){document.removeEventListener('keydown',overlay._onKey);overlay.remove();overlay=null;}},300);
        highlightId=null;nodes=[];edges=[];
    }

    window.openFlowchart=openFlowchart;
    window.closeFlowchart=closeFlowchart;
})();
