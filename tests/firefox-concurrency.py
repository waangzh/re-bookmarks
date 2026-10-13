"""仅用于独立 geckodriver 会话。Usage: script driver-url session-id artifact-dir"""
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

driver, session, directory = sys.argv[1:]
directory = Path(directory).resolve()


def command(path, data=None, method="POST"):
    request = urllib.request.Request(driver + "/session/" + session + path,
                                     json.dumps(data).encode() if data is not None else None,
                                     {"Content-Type": "application/json"}, method=method)
    return json.load(urllib.request.urlopen(request, timeout=30))["value"]


def evaluate(script):
    result = command("/execute/async", {"script": "const done=arguments[arguments.length-1];Promise.resolve().then(()=>" + script +
                     ").then(value=>done({value}),error=>done({error:String(error)}));", "args": []})
    if "error" in result:
        raise RuntimeError(result["error"])
    return result.get("value")


archive = directory / "concurrency-extension.zip"
with zipfile.ZipFile(archive, "w") as output:
    for file in Path("dist-firefox").rglob("*"):
        if file.is_file():
            output.write(file, file.relative_to("dist-firefox"))
    for name in ["concurrency-probe.js", "concurrency-probe.html", "concurrency-loader.js"]:
        output.write(directory / name, name)
command("/moz/addon/install", {"path": str(archive), "temporary": True})
command("/moz/context", {"context": "chrome"})
base = command("/execute/sync", {"script": 'return ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs").ExtensionParent.GlobalManager.getExtension("remarks@waangzh.github.io").baseURI.spec;', "args": []})
command("/moz/context", {"context": "content"})
command("/url", {"url": base + "concurrency-probe.html"})
first = command("/window", method="GET")
second = command("/window/new", {"type": "tab"})["handle"]
command("/window", {"handle": second})
command("/url", {"url": base + "concurrency-probe.html"})
assert evaluate("!!navigator.locks?.request")
fixture = evaluate("""(async()=>{const tree=await browser.bookmarks.getTree();const root=tree[0].children.find(item=>!item.url&&!item.unmodifiable);
const folder=await browser.bookmarks.create({parentId:root.id,title:'__Concurrent_storage__'});const nodes=[];
for(let index=0;index<40;index++)nodes.push(await browser.bookmarks.create({parentId:folder.id,title:'并发节点 '+index,url:'https://example.invalid/concurrency/'+index}));
return {folder,nodes};})()""")
time.sleep(1)


def run_pair(expressions):
    start = int(time.time() * 1000) + 1000
    for handle, expression in zip([first, second], expressions):
        command("/window", {"handle": handle})
        assert evaluate("!!window.probe"), "测试脚本尚未加载"
        command("/execute/sync", {"script": "window.result=null;setTimeout(()=>" + expression +
                ".then(value=>window.result={value},error=>window.result={error:String(error)}),Math.max(0," + str(start) + "-Date.now()));return true;", "args": []})
    deadline = time.monotonic() + 20
    complete = {}
    while time.monotonic() < deadline:
        for handle in [first, second]:
            command("/window", {"handle": handle})
            result = evaluate("window.result")
            if result:
                assert "error" not in result, result
                complete[handle] = result
        if len(complete) == 2:
            return
        time.sleep(0.1)
    raise RuntimeError("并发测试超时")


evaluate("browser.storage.local.set({'remarks.pendingRecommendations':[]})")
run_pair(["window.probe.appendRecommendations(" + json.dumps(fixture["nodes"][:20]) + "," + json.dumps(fixture["folder"]["id"]) + ")",
          "window.probe.appendRecommendations(" + json.dumps(fixture["nodes"][20:]) + "," + json.dumps(fixture["folder"]["id"]) + ")"])
items = evaluate("browser.storage.local.get('remarks.pendingRecommendations').then(state=>state['remarks.pendingRecommendations'])")
assert len(items) == 40 and len({item["bookmarkId"] for item in items}) == 40, len(items)
run_pair(["window.probe.addRules('pagea'," + json.dumps(fixture["folder"]["id"]) + ")",
          "window.probe.addRules('pageb'," + json.dumps(fixture["folder"]["id"]) + ")"])
rules = evaluate("browser.storage.local.get('remarks.fixedDomainRules').then(state=>state['remarks.fixedDomainRules'])")
assert len(rules) == 10 and len({rule["domain"] for rule in rules}) == 10, len(rules)
result = {"browser": "Firefox", "nativeWebLocks": True, "separateExtensionPages": 2, "recommendations": len(items), "uniqueRecommendations": 40, "fixedRules": len(rules)}
(directory / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(result)
