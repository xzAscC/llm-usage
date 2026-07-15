pragma Singleton
pragma ComponentBehavior: Bound

import qs.modules.common
import qs.modules.common.functions
import QtQuick
import Quickshell
import Quickshell.Io

/**
 * Local LLM subscription usage service.
 * Uses project-local CLI only (absolute bun + project path). No global install.
 * Cache: ~/.cache/llm-usage/snapshot.json
 */
Singleton {
    id: root

    readonly property string projectRoot: "/home/xzascc/Documents/code/LLMUsage"
    readonly property string bunPath: "/usr/bin/bun"
    readonly property string entryPath: projectRoot + "/src/index.ts"
    readonly property string cachePath: FileUtils.trimFileProtocol(Directories.home) + "/.cache/llm-usage/snapshot.json"

    property bool ready: false
    property var providers: []
    property real worstUsedPercent: 0
    property string severity: "unknown"
    property string fetchedAt: ""
    property string lastError: ""
    property bool checking: refreshProc.running

    function load() {
        refresh()
    }

    function refresh() {
        if (refreshProc.running)
            return
        refreshProc.running = true
    }

    function applySnapshot(text) {
        try {
            const data = JSON.parse(text)
            root.providers = data.providers || []
            root.worstUsedPercent = Number(data.worstUsedPercent ?? 0)
            root.severity = data.severity || "unknown"
            root.fetchedAt = data.fetchedAt || ""
            root.lastError = ""
            root.ready = Array.isArray(root.providers) && root.providers.length > 0
        } catch (e) {
            root.lastError = String(e)
            root.ready = false
        }
    }

    Timer {
        id: pollTimer
        interval: 500
        running: true
        repeat: true
        onTriggered: {
            root.refresh()
            interval = (Config.options?.bar?.llmUsage?.refreshInterval ?? 300) * 1000
        }
    }

    Process {
        id: refreshProc
        command: [root.bunPath, root.entryPath, "json", "--force"]
        stdout: StdioCollector {
            onStreamFinished: {
                if (text && text.trim().length > 0)
                    root.applySnapshot(text.trim())
                cacheFile.reload()
            }
        }
        stderr: StdioCollector {
            onStreamFinished: {
                if (text && text.trim().length > 0)
                    root.lastError = text.trim().slice(0, 240)
            }
        }
        onExited: (exitCode, _exitStatus) => {
            if (exitCode !== 0 && !root.ready)
                root.lastError = root.lastError || ("llm-usage exited " + exitCode)
            cacheFile.reload()
        }
    }

    FileView {
        id: cacheFile
        path: root.cachePath
        watchChanges: true
        onFileChanged: reload()
        onLoaded: {
            const t = text()
            if (t && t.trim().length > 0)
                root.applySnapshot(t)
        }
        onLoadFailed: _err => {}
    }

    Component.onCompleted: {
        cacheFile.reload()
        root.refresh()
    }
}
