// kwin-indicator.js — 让 see-now 的光晕窗真正置顶（KWin 脚本）。
//
// Wayland 的 xdg_toplevel 没有"总在最前"这个状态，Qt 的 WindowStaysOnTopHint
// 在 KWin 上不生效。KWin 脚本可以直接改合成器侧的 keepAbove，这才是稳的做法。
//
// 加载：qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript <本文件>
//       qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start
// （indicator.js 负责调，失败只是"可能被别的窗口盖住"，不影响采集）
(function () {
    function apply(w) {
        if (!w) return;
        var id = String(w.resourceClass || "") + " " + String(w.resourceName || "")
            + " " + String(w.caption || "");
        if (id.indexOf("see-now-indicator") >= 0) {
            w.keepAbove = true;
            w.skipTaskbar = true;
            w.noBorder = true;
        }
    }
    function all() {
        var list = workspace.windowList ? workspace.windowList() : workspace.clientList();
        for (var i = 0; i < list.length; i++) apply(list[i]);
    }
    all();
    if (workspace.windowAdded) workspace.windowAdded.connect(apply);
    if (workspace.clientAdded) workspace.clientAdded.connect(apply);
})();
