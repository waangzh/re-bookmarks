const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/app/components/HabitPresets.tsx"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

const fixture = {
  id: "profile",
  createdAt: 1,
  folderCount: 2,
  bookmarkCount: 4,
  summary: "Research folders",
  preferredTopLevelFolders: ["Research"],
  folderRules: [
    { folderPath: ["Research", "Admissions"], pattern: "Application documents" },
    { folderPath: ["Research"], pattern: "General research resources" },
  ],
  avoidRules: [],
  promptHint: "Reuse existing folders",
};

function nodes(root, predicate) {
  if (Array.isArray(root)) return root.flatMap((child) => nodes(child, predicate));
  if (!root || typeof root !== "object" || !root.props) return [];
  return [...(predicate(root) ? [root] : []), ...nodes(root.props.children, predicate)];
}

function text(root) {
  if (Array.isArray(root)) return root.map(text).join("");
  if (typeof root === "string" || typeof root === "number") return String(root);
  return root?.props ? text(root.props.children) : "";
}

// Simulate component draft transitions without a browser or extension storage.
function harness(options = {}) {
  const state = [];
  const saved = [];
  let cursor = 0;
  const context = {
    exports: {},
    Error,
    require(id) {
      if (id === "react") return {
        useState(initial) {
          const index = cursor++;
          if (state.length <= index) {
            state[index] = index === 0 ? structuredClone(fixture)
              : index === 1 ? "idle"
                : typeof initial === "function" ? initial() : initial;
          }
          return [state[index], (value) => {
            state[index] = typeof value === "function" ? value(state[index]) : value;
          }];
        },
        useEffect() {},
        useRef: () => ({ current: null }),
      };
      if (id === "react/jsx-runtime" || id === "lucide-react") return require(id);
      if (id === "./PageHeading") return { PageHeading: () => null };
      assert.equal(id, "../services/habits");
      return {
        getFolderHabitProfile: async () => structuredClone(fixture),
        cleanFolderHabitProfile: (profile) => profile,
        analyzeAndSaveFolderHabits: async () => structuredClone(fixture),
        importFolderHabitProfileJson: async () => structuredClone(fixture),
        exportFolderHabitProfile: (profile) => JSON.stringify(profile),
        async saveEditedFolderHabitProfile(profile) {
          if (options.saveError) throw new Error("Simulated storage write failure");
          saved.push(JSON.parse(JSON.stringify(profile)));
          return profile;
        },
      };
    },
  };
  vm.runInNewContext(compiled, context, { filename: "HabitPresets.tsx" });
  const render = () => { cursor = 0; return context.exports.HabitPresets(); };
  const row = (index) => nodes(render(), (node) =>
    node.props.className === "habit-rule-row" && node.key === String(index))[0];
  const edit = (index) => nodes(row(index), (node) =>
    node.props.className === "habit-rule-row__edit")[0].props.onClick();
  const changePath = (index, folderPath) => nodes(row(index), (node) =>
    node.type?.name === "FolderPathBuilder")[0].props.onChange(folderPath);
  const changePattern = (index, value) => nodes(row(index), (node) =>
    node.type?.name === "AutoResizeTextarea")[0].props.onChange({ target: { value } });
  const remove = (index) => nodes(row(index), (node) =>
    node.props.className === "habit-rule-row__delete")[0].props.onClick();
  const click = (label) => {
    const button = nodes(render(), (node) => node.type === "button" && text(node) === label)[0];
    assert.ok(button, `Button not found: ${label}`);
    return button.props.onClick({ stopPropagation() {} });
  };
  return { render, row, edit, changePath, changePattern, remove, click, saved };
}

test("default rows show names and editable descriptions, with no path controls or per-row save", () => {
  const view = harness();
  const tree = view.render();
  assert.equal(nodes(tree, (node) => node.type?.name === "FolderPathBuilder").length, 0);
  assert.equal(nodes(tree, (node) => node.type?.name === "AutoResizeTextarea" &&
    node.props.id?.startsWith("habit-rule-pattern-")).length, 2);
  assert.equal(nodes(tree, (node) => node.props["aria-label"] === "保存规则").length, 0);
  assert.equal(text(nodes(view.row(0), (node) => node.props.className === "habit-rule-row__name")[0]), "Admissions");
  assert.equal(text(nodes(view.row(1), (node) => node.props.className === "habit-rule-row__name")[0]), "当前父分类");
  assert.ok(text(view.row(0)).includes("删除规则"));
  assert.equal(view.saved.length, 0);
});

test("typing a first-level path preserves the group and row key until editing closes", () => {
  const view = harness();
  view.edit(0);
  const before = view.row(0);
  view.changePath(0, ["New research", "Admissions"]);
  const tree = view.render();
  const groups = nodes(tree, (node) => node.props.className === "habit-folder-group");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "Research");
  assert.equal(view.row(0).key, before.key);
  assert.equal(nodes(tree, (node) => node.type?.name === "FolderPathBuilder").length, 1);
  assert.equal(view.saved.length, 0);
  view.edit(0);
  const moved = nodes(view.render(), (node) => node.props.className === "habit-folder-group" && node.key === "New research")[0];
  assert.ok(moved);
  assert.equal(moved.props.open, true);
  assert.equal(nodes(view.render(), (node) => node.type?.name === "FolderPathBuilder").length, 0);
});

test("top-level Save includes an expanded path editor and directly edited description", async () => {
  const view = harness();
  view.edit(0);
  view.changePath(0, ["New research", "Admissions"]);
  view.changePattern(0, "Updated application documents");
  assert.equal(view.saved.length, 0);
  await view.click("保存调整");
  assert.equal(view.saved.length, 1);
  assert.deepEqual(view.saved[0].folderRules[0], {
    folderPath: ["New research", "Admissions"],
    pattern: "Updated application documents",
  });
  assert.equal(nodes(view.render(), (node) => node.type?.name === "FolderPathBuilder").length, 0);
});

test("a failed save retains the edited path, open editor, and error feedback", async () => {
  const view = harness({ saveError: true });
  view.edit(0);
  view.changePath(0, ["New research", "Admissions"]);
  await view.click("保存调整");
  const tree = view.render();
  const builder = nodes(tree, (node) => node.type?.name === "FolderPathBuilder")[0];
  assert.equal(builder.props.value[0], "New research");
  assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 1);
  assert.ok(text(tree).includes("Simulated storage write failure"));
  assert.equal(view.saved.length, 0);
});

test("switching path editors keeps the previous draft and opens only the selected editor", () => {
  const view = harness();
  view.edit(0);
  view.changePath(0, ["New research", "Admissions"]);
  view.edit(1);
  const tree = view.render();
  const builders = nodes(tree, (node) => node.type?.name === "FolderPathBuilder");
  assert.equal(builders.length, 1);
  assert.equal(builders[0].props.value.length, 1);
  assert.equal(nodes(tree, (node) => node.props.className === "habit-folder-group").length, 2);
  assert.equal(nodes(view.row(0), (node) => node.props.className === "habit-rule-row__name")[0].props.title, "New research / Admissions");
  assert.equal(view.saved.length, 0);
});

test("deleting a preceding rule closes the editor without losing the remaining path draft", async () => {
  const view = harness();
  view.edit(1);
  view.changePath(1, ["New research"]);
  view.remove(0);
  assert.equal(nodes(view.render(), (node) => node.props.className === "habit-rule-row").length, 1);
  assert.equal(nodes(view.render(), (node) => node.type?.name === "FolderPathBuilder").length, 0);
  assert.equal(view.saved.length, 0);
  await view.click("保存调整");
  assert.deepEqual(view.saved[0].folderRules, [
    { folderPath: ["New research"], pattern: "General research resources" },
  ]);
});

test("adding a parent rule opens its group and path editor without persisting", async () => {
  const view = harness();
  view.click("新建父分类");
  const group = nodes(view.render(), (node) => node.props.className === "habit-folder-group" && node.key === "未命名分类")[0];
  assert.ok(group);
  assert.equal(group.props.open, true);
  view.changePath(2, ["New parent"]);
  view.changePattern(2, "New rule");
  assert.equal(view.saved.length, 0);
  await view.click("保存调整");
  assert.deepEqual(view.saved[0].folderRules[2], { folderPath: ["New parent"], pattern: "New rule" });
});

test("adding a child rule keeps its parent and expands the new path controls", () => {
  const view = harness();
  nodes(view.render(), (node) => node.props["aria-label"] === "更多操作")[0].props.onClick({ stopPropagation() {} });
  view.click("添加子分类");
  const builder = nodes(view.row(2), (node) => node.type?.name === "FolderPathBuilder")[0];
  assert.equal(builder.props.value[0], "Research");
  assert.equal(builder.props.value[1], "");
  assert.equal(view.saved.length, 0);
});

test("removing a group clears its editor and changes only the draft", () => {
  const view = harness();
  view.edit(0);
  nodes(view.render(), (node) => node.props["aria-label"] === "更多操作")[0].props.onClick({ stopPropagation() {} });
  view.click("移除此组规则");
  const tree = view.render();
  assert.equal(nodes(tree, (node) => node.props.className === "habit-rule-row").length, 0);
  assert.equal(nodes(tree, (node) => node.type?.name === "FolderPathBuilder").length, 0);
  assert.equal(view.saved.length, 0);
});

test("refreshing the profile clears an obsolete path editor", async () => {
  const view = harness();
  view.edit(0);
  view.changePath(0, ["New research", "Admissions"]);
  await view.click("更新书签画像");
  assert.equal(nodes(view.render(), (node) => node.type?.name === "FolderPathBuilder").length, 0);
  assert.equal(nodes(view.render(), (node) => node.props.className === "habit-folder-group")[0].key, "Research");
});
