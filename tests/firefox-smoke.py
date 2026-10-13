"""Run against an explicitly created, isolated geckodriver session (stdlib only).

Usage: python -X utf8 tests/firefox-smoke.py <driver-url> <session-id> <artifact-dir>
"""
import base64
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

driver, session, artifact_dir = sys.argv[1:]
artifacts = Path(artifact_dir).resolve()
artifacts.mkdir(parents=True, exist_ok=True)


def command(path, data=None, method="POST"):
    request = urllib.request.Request(driver + "/session/" + session + path,
                                     json.dumps(data).encode() if data is not None else None, {"Content-Type": "application/json"}, method=method)
    try:
        return json.load(urllib.request.urlopen(request, timeout=30))["value"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


def evaluate(expression):
    result = command("/execute/async", {
        "script": "const done=arguments[arguments.length-1]; Promise.resolve().then(()=>" + expression +
                  ").then(value=>done({value}),error=>done({error:String(error)}));",
        "args": [],
    })
    if result is None:
        return None
    if "error" in result:
        raise RuntimeError(result["error"])
    return result.get("value")


def until(expression):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if evaluate(expression):
            return
        time.sleep(0.1)
    raise RuntimeError("页面状态等待超时: " + expression)


archive = artifacts / "extension.zip"
with zipfile.ZipFile(archive, "w") as output:
    for file in Path("dist-firefox").rglob("*"):
        if file.is_file():
            output.write(file, file.relative_to("dist-firefox"))
command("/moz/addon/install", {"path": str(archive), "temporary": True})
command("/moz/context", {"context": "chrome"})
base = command("/execute/sync", {
    "script": 'return ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs").ExtensionParent.GlobalManager.getExtension("remarks@waangzh.github.io").baseURI.spec;',
    "args": [],
})
command("/moz/context", {"context": "content"})
command("/timeouts", {"script": 20000})
command("/window/rect", {"width": 450, "height": 850})
command("/url", {"url": base + "sidebar/index.html"})
until("!!document.querySelector('.home-v2') || !!document.querySelector('.onboarding')")
# Retain the actual Firefox sidebar viewport, which can be narrower than the outer window.
if evaluate("!!document.querySelector('.onboarding')"):
    evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('先检查书签')).click()")
    until("location.hash.includes('/manage')")
results = ["无 API Key 本地路径可用"]
fixture = evaluate("""(async()=>{
const tree=await browser.bookmarks.getTree();
const root=tree[0].children.find(node=>!node.url&&!node.unmodifiable);
const group=await browser.bookmarks.create({parentId:root.id,title:'__ReMarks_v2_Firefox_validation__'});
const source=await browser.bookmarks.create({parentId:group.id,title:'资料'});
const target=await browser.bookmarks.create({parentId:group.id,title:'工具'});
const nodes=[];
for(const title of ['有效项','后续改名']) nodes.push(await browser.bookmarks.create({parentId:source.id,title,url:'https://example.invalid/ff-'+nodes.length}));
return {group,source,target,nodes};})()""")
until("(async()=>{const state=await browser.storage.local.get('remarks.pendingRecommendations');return (state['remarks.pendingRecommendations']||[]).length>=2})()")
results.append("真实新增书签事件进入待处理推荐")
command("/url", {"url": base + "sidebar/index.html#/manage?task=unsorted"})
until("!!document.querySelector('.bookmark-unsorted-card--recommendation')")
assert evaluate("document.body.innerText.includes('有效项')")
evaluate("Array.from(document.querySelectorAll('.bookmark-unsorted-card--recommendation')).find(card=>card.textContent.includes('有效项')).querySelector('[aria-label=\"编辑推荐分类\"]').click()")
until("!!document.querySelector('.bookmark-recommendation-edit input')")
target_path = fixture["group"]["title"] + " / " + fixture["target"]["title"]
evaluate("(()=>{const input=document.querySelector('.bookmark-recommendation-edit input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input," + json.dumps(target_path) + ");input.dispatchEvent(new Event('input',{bubbles:true}));})()")
evaluate("document.querySelector('[aria-label=\"保存推荐分类\"]').click()")
until("document.body.innerText.includes('你已指定')")
evaluate("Array.from(document.querySelectorAll('.bookmark-unsorted-card--recommendation')).find(card=>card.textContent.includes('有效项')).querySelector('[aria-label=\"归档书签\"]').click()")
until("(async()=>{const nodes=await browser.bookmarks.get(" + json.dumps(fixture["nodes"][0]["id"]) + ");return nodes[0].parentId===" + json.dumps(fixture["target"]["id"]) + "})()")
results.append("无 API Key 失败建议可直接指定目录并经备份归档")
# Return this isolated fixture to the source for the independent preview scenario.
evaluate("browser.bookmarks.move(" + json.dumps(fixture["nodes"][0]["id"]) + ",{parentId:" + json.dumps(fixture["source"]["id"]) + "})")
plans = [{"bookmarkId": item["id"], "bookmarkTitle": item["title"], "bookmarkUrl": item["url"],
          "fromParentId": fixture["source"]["id"], "sourceFolderPath": [fixture["group"]["title"], fixture["source"]["title"]],
          "toFolderPath": [fixture["group"]["title"], fixture["target"]["title"]],
          "expectedTargetId": fixture["target"]["id"], "confidence": 0.8, "source": "ai", "reason": "隔离测试预览，不调用 AI"}
         for item in fixture["nodes"]]
preview = {"id": "firefox-validation", "createdAt": int(time.time() * 1000), "bookmarkCount": 2,
           "whitelistFingerprint": "", "movePlan": plans}
evaluate("browser.storage.local.set({'remarks.previewPlan':" + json.dumps(preview) + "})")
command("/url", {"url": base + "sidebar/index.html#/preview"})
until("Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='接受这组')")
evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='保留这组').click()")
until("document.body.innerText.includes('全部保留')")
evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='接受这组').click()")
until("(async()=>{const state=await browser.storage.local.get('remarks.previewReview');return Object.values(state['remarks.previewReview']?.plans||{}).filter(value=>value==='move').length===2})()")
command("/url", {"url": base + "sidebar/index.html#/preview"})
until("document.querySelector('.extension-page__primary-button')&&!document.querySelector('.extension-page__primary-button').disabled")
results.append("整组保留、批准和重开恢复审核决定")
evaluate("document.querySelector('.extension-page__primary-button').click()")
until("!!document.querySelector('[aria-label=\"最终执行确认\"]')")
before = evaluate("browser.bookmarks.get(" + json.dumps([node["id"] for node in fixture["nodes"]]) + ")")
assert all(node["parentId"] == fixture["source"]["id"] for node in before)
evaluate("document.querySelector('[aria-label=\"最终执行确认\"] .extension-page__wide-primary').click()")
until("location.hash.includes('/report') && document.body.innerText.includes('本次执行记录')")
state = evaluate("browser.storage.local.get(['remarks.lastReport','remarks.lastBackup'])")
assert state["remarks.lastReport"]["movedCount"] == 2, state["remarks.lastReport"]
assert state["remarks.lastBackup"]["tree"]
results.append("确认前不写入，确认后真实备份、移动和报告通过")
evaluate("browser.bookmarks.update(" + json.dumps(fixture["nodes"][1]["id"]) + ",{title:'用户后续改名'})")
evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('撤销本次整理')).click()")
command("/alert/accept", {})
until("document.body.innerText.includes('失败明细')")
undo = evaluate("browser.storage.local.get('remarks.lastReport')")["remarks.lastReport"]
assert undo["movedCount"] == 1 and len(undo["failedItems"]) == 1, undo
results.append("真实撤销保留后续改名，只移回仍符合快照的项")
# Test safe backup recovery through the actual backup UI, retaining a later bookmark.
evaluate("browser.bookmarks.create({parentId:" + json.dumps(fixture["group"]["id"]) + ",title:'备份后新增',url:'https://example.invalid/after-backup'})")
command("/url", {"url": base + "sidebar/index.html#/backups"})
until("Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes('恢复'))")
evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('恢复')).click()")
command("/alert/accept", {})
until("document.body.innerText.includes('恢复完成') || document.body.innerText.includes('已恢复')")
restored = evaluate("browser.bookmarks.get(" + json.dumps(fixture["nodes"][1]["id"]) + ")")
assert restored[0]["title"] == fixture["nodes"][1]["title"]
tree_text = evaluate("browser.bookmarks.getTree().then(tree=>JSON.stringify(tree))")
assert "after-backup" in tree_text
results.append("真实安全恢复保留备份后新增书签并恢复备份内的标题")
permission = evaluate("browser.permissions.contains({permissions:['history']})")
assert permission is False
results.append("未启用历史时没有 history 授权")
layout = evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth})")
assert layout["scroll"] <= layout["width"]
screenshot = command("/screenshot", method="GET")
(artifacts / "firefox-smoke.png").write_bytes(base64.b64decode(screenshot))
result = {"results": results, "layout": layout, "historyPermission": permission}
(artifacts / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=True, indent=2))
