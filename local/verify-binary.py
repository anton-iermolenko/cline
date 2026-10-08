#!/usr/bin/env python3
"""Exercise compiled startup and saved model metadata using an isolated local API."""
import http.server, json, os, pathlib, subprocess, tempfile, threading, sys, pty, select, time, signal, fcntl, termios, struct
BINARY = sys.argv[1]
requests = []
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body=json.dumps({'object':'list','data':[{'id':'qwen-27b','object':'model'}]}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({**{k: body.get(k) for k in ['model','max_tokens','max_completion_tokens','reasoning_effort']},'input_chars':len(json.dumps(body.get('messages',[])))})
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        chunks=[{'id':'smoke','object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','content':'READY'},'finish_reason':None}]}, {'id':'smoke','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':20,'completion_tokens':1,'total_tokens':21}}]
        for chunk in chunks: self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='cline-fork-verify-') as temp:
    root=pathlib.Path(temp); data=root/'data'; settings=data/'settings'; settings.mkdir(parents=True)
    (root/'workspace').mkdir(); (root/'hooks').mkdir()
    provider={'provider':'openai-compatible','model':'qwen-27b','baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test-placeholder','reasoning':{'enabled':True,'effort':'medium'}}
    if '--live' in sys.argv:
        provider=json.loads((pathlib.Path.home() / '.cline/data/settings/providers.json').read_text())['providers']['openai-compatible']['settings'].copy()
        provider.pop('contextWindow',None); provider.pop('maxTokens',None)
    (settings/'providers.json').write_text(json.dumps({'version':1,'lastUsedProvider':'openai-compatible','providers':{'openai-compatible':{'settings':provider,'updatedAt':'2026-10-08T00:00:00Z'}}}))
    model={'id':'qwen-27b','contextWindow':81920,'maxInputTokens':73728,'maxTokens':8192}
    (settings/'models.json').write_text(json.dumps({'version':1,'providers':{'openai-compatible':{'models':{'qwen-27b':model}}}}))
    env={**os.environ,'HOME':temp,'CLINE_DIR':str(root/'.cline'),'CLINE_DATA_DIR':str(data),'CLINE_NO_AUTO_UPDATE':'1'}
    args=[BINARY,'--data-dir',str(data),'--cwd',str(root/'workspace'),'--hooks-dir',str(root/'hooks'),'--provider','openai-compatible','--model','qwen-27b','--json','--compaction','basic','--timeout','30','Reply READY. Do not call tools.']
    if '--tui' in sys.argv:
        args.remove('--json'); args.insert(1,'--tui')
        master, slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
        process=subprocess.Popen(args,env={**env,'TERM':'xterm-256color'},stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave); output=b''; deadline=time.monotonic()+35; received_at=None
        while time.monotonic()<deadline and process.poll() is None:
            if select.select([master],[],[],0.25)[0]:
                try: output+=os.read(master,65536)
                except OSError: break
            if requests and received_at is None: received_at=time.monotonic()
            if received_at and time.monotonic()-received_at>3: break
        os.killpg(process.pid,signal.SIGTERM)
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL); process.wait()
        os.close(master)
        result=subprocess.CompletedProcess(args,0 if requests else 1,output.decode(errors='replace'),'')
    else:
        result=subprocess.run(args,env=env,capture_output=True,text=True,timeout=90)
    infos=[]
    def walk(value):
        if isinstance(value,dict):
            if isinstance(value.get('modelInfo'),dict): infos.append(value['modelInfo'])
            if isinstance(value.get('model'),dict) and isinstance(value['model'].get('info'),dict): infos.append(value['model']['info'])
            for item in value.values(): walk(item)
        elif isinstance(value,list):
            for item in value: walk(item)
    for line in result.stdout.splitlines():
        try: walk(json.loads(line))
        except ValueError: pass
    for path in root.rglob('*.json'):
        try: walk(json.loads(path.read_text()))
        except (ValueError,UnicodeError): pass
    expected={'contextWindow':81920,'maxInputTokens':73728,'maxTokens':8192}
    matched=[{key: info.get(key) for key in ['id','provider',*expected]} for info in infos if all(info.get(k)==v for k,v in expected.items())]
    persisted_ready=any(any(m.get('role')=='assistant' and any(c.get('text')=='READY' for c in m.get('content',[]) if isinstance(c,dict)) for m in json.loads(p.read_text()).get('messages',[])) for p in root.rglob('*.messages.json'))
    print(json.dumps({'persisted_ready':persisted_ready,'exit_code':result.returncode,'requests':requests,'runtime_model_info':matched,'ready_received':'READY' in result.stdout},indent=2))
    if ('--live' not in sys.argv and not requests) or result.returncode != 0 or ('--tui' not in sys.argv and not matched) or ('--tui' in sys.argv and not persisted_ready):
        print(result.stdout[-1200:]); print(result.stderr[-2000:]); raise SystemExit(1)
    if '--live' not in sys.argv:
        assert requests[0].get('max_tokens') == 8192 or requests[0].get('max_completion_tokens') == 8192
server.shutdown()
