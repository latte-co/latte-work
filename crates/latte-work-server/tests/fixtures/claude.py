#!/usr/bin/env python3
"""Deterministic native-protocol fixture. Never connects to a model."""
import sys,json,time,os,subprocess
if '--version' in sys.argv:
    print('fixture-claude 1.0');sys.exit(0)
def emit(value): print(json.dumps(value),flush=True)
resumed=any(arg.startswith('--resume=') for arg in sys.argv)
for line in sys.stdin:
    value=json.loads(line)
    if value['type']=='control_request':
        emit({'type':'control_response','response':{'subtype':'success','request_id':value['request_id'],'response':{}}})
    elif value['type']=='user':
        text=value['message']['content']
        emit({'type':'system','subtype':'init','session_id':'11111111-1111-4111-8111-111111111111'})
        if text=='malformed': print('this is not json',flush=True);sys.exit(0)
        if text=='exit': sys.exit(2)
        if text=='hang':
            child=subprocess.Popen(['sleep','120'])
            emit({'type':'assistant','message':{'content':[{'type':'text','text':f'child:{child.pid}'}]}})
            time.sleep(120)
        if text=='effort':
            with open(sys.argv[sys.argv.index('--settings')+1]) as f:settings=json.load(f)
            effort=settings['env']['CLAUDE_CODE_EFFORT_LEVEL']
            assert os.environ['CLAUDE_CODE_EFFORT_LEVEL']==effort
            if effort!='auto':assert '--effort='+effort in sys.argv
            else:assert not any(a.startswith('--effort=') for a in sys.argv)
            emit({'type':'assistant','message':{'content':[{'type':'text','text':('resumed:' if resumed else 'fresh:')+effort}]}})
            emit({'type':'result','subtype':'success','is_error':False})
        elif text=='model':
            model=next((a.split('=',1)[1] for a in sys.argv if a.startswith('--model=')), 'cli-config')
            emit({'type':'assistant','message':{'content':[{'type':'text','text':('resumed:' if resumed else 'fresh:')+model}]}})
            emit({'type':'result','subtype':'success','is_error':False})
        elif text=='provider':
            with open(sys.argv[sys.argv.index('--settings')+1]) as f:settings=json.load(f)
            env=settings['env']
            assert env['ANTHROPIC_API_KEY']=='fixture-private-key'
            assert env['ANTHROPIC_BASE_URL']=='https://example.test'
            model=next(a.split('=',1)[1] for a in sys.argv if a.startswith('--model='))
            assert env['ANTHROPIC_MODEL']==model
            emit({'type':'assistant','message':{'content':[{'type':'text','text':('resumed:' if resumed else 'fresh:')+model+':api_key'}]}})
            emit({'type':'result','subtype':'success','is_error':False})
        elif text=='approve':
            emit({'type':'assistant','message':{'content':[{'type':'tool_use','id':'tool-1','name':'Write','input':{'file_path':'approved.txt','content':'approved'}}]}})
            emit({'type':'control_request','request_id':'permission-1','request':{'subtype':'can_use_tool','tool_name':'Write','input':{'file_path':'approved.txt','content':'approved'}}})
        else:
            for token in ['resumed:' if resumed else 'fresh:','你好']:
                emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':token}}})
            emit({'type':'assistant','message':{'content':[{'type':'text','text':'resumed:你好' if resumed else 'fresh:你好'}]}})
            emit({'type':'result','subtype':'success','is_error':False})
    elif value['type']=='control_response':
        response=value['response']['response'];allowed=response['behavior']=='allow'
        if allowed:
            assert response['updatedInput']['file_path']=='approved.txt'
            with open('approved.txt','w') as f:f.write('approved')
        emit({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'tool-1','content':'allowed' if allowed else 'denied','is_error':not allowed}]}})
        emit({'type':'result','subtype':'success','is_error':False})
