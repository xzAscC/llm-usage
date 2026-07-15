import qs.modules.common
import qs.modules.common.widgets
import qs.modules.ii.bar
import qs.modules.common.functions
import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

/**
 * Self-contained LLM usage bar chip.
 * Lives in the LLMUsage project; loaded via Loader from BarContent.
 * Data: ~/.cache/llm-usage/snapshot.json via project-local bun CLI.
 */
MouseArea {
    id: root

    // --- state ---
    property bool popupOpen: false
    property bool ready: false
    property bool checking: false
    property var providers: []
    property real worstUsedPercent: 0
    property string severity: "unknown"
    property string lastError: ""
    property string fetchedAt: ""

    readonly property string projectRoot: "/home/xzascc/Documents/code/LLMUsage"
    readonly property string bunPath: "/usr/bin/bun"
    readonly property string entryPath: projectRoot + "/src/index.ts"
    readonly property string cachePath: FileUtils.trimFileProtocol(Directories.home) + "/.cache/llm-usage/snapshot.json"
    readonly property real usedFraction: Math.min(1, Math.max(0, worstUsedPercent / 100))
    readonly property bool isWarn: severity === "warn"
    readonly property bool isCrit: severity === "crit" || severity === "error"

    implicitWidth: row.implicitWidth + 10
    implicitHeight: Appearance.sizes.barHeight
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor

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

    function refresh() {
        if (refreshProc.running)
            return
        root.checking = true
        refreshProc.running = true
    }

    function formatReset(w) {
        if (w && w.resetAfterSeconds != null && w.resetAfterSeconds >= 0) {
            const s = Math.floor(w.resetAfterSeconds)
            const d = Math.floor(s / 86400)
            const h = Math.floor((s % 86400) / 3600)
            const m = Math.floor((s % 3600) / 60)
            if (d > 0) return d + "d " + h + "h"
            if (h > 0) return h + "h " + m + "m"
            return m + "m"
        }
        return "—"
    }

    function shortId(id) {
        if (id === "openai") return "OpenAI"
        if (id === "zai") return "GLM"
        if (id === "xai") return "Grok"
        return id || "?"
    }

    onClicked: event => {
        if (event.button === Qt.RightButton) {
            root.refresh()
            return
        }
        root.popupOpen = !root.popupOpen
    }

    // click-toggle proxy for StyledPopup (active binds to containsMouse)
    Item {
        id: popupAnchor
        anchors.fill: parent
        property bool containsMouse: root.popupOpen
    }

    RowLayout {
        id: row
        anchors.centerIn: parent
        spacing: 3

        ClippedFilledCircularProgress {
            id: circ
            Layout.alignment: Qt.AlignVCenter
            lineWidth: Appearance.rounding.unsharpen
            value: root.usedFraction
            implicitSize: 20
            colPrimary: root.isCrit
                ? Appearance.colors.colError
                : root.isWarn
                    ? Appearance.m3colors.m3tertiary
                    : Appearance.colors.colOnSecondaryContainer
            accountForLightBleeding: !root.isCrit
            enableAnimation: false

            Item {
                anchors.centerIn: parent
                width: circ.implicitSize
                height: circ.implicitSize
                MaterialSymbol {
                    anchors.centerIn: parent
                    font.weight: Font.DemiBold
                    fill: 1
                    text: "auto_awesome"
                    iconSize: Appearance.font.pixelSize.normal
                    color: Appearance.m3colors.m3onSecondaryContainer
                }
            }
        }

        StyledText {
            Layout.alignment: Qt.AlignVCenter
            color: Appearance.colors.colOnLayer1
            font.pixelSize: Appearance.font.pixelSize.small
            text: root.ready
                ? ("" + Math.round(root.worstUsedPercent || 0))
                : (root.checking ? "…" : "!")
        }
    }

    // --- data sources ---
    Timer {
        interval: 400
        running: true
        repeat: true
        onTriggered: {
            root.refresh()
            interval = 300000 // 5 min
        }
    }

    Process {
        id: refreshProc
        command: [root.bunPath, root.entryPath, "json", "--force"]
        stdout: StdioCollector {
            onStreamFinished: {
                root.checking = false
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
        onExited: (code, _st) => {
            root.checking = false
            if (code !== 0 && !root.ready)
                root.lastError = root.lastError || ("exit " + code)
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
    }

    Component.onCompleted: {
        cacheFile.reload()
        root.refresh()
    }

    // --- popup (inline, no separate type) ---
    StyledPopup {
        hoverTarget: popupAnchor

        Row {
            anchors.centerIn: parent
            spacing: 24

            Repeater {
                model: root.providers

                delegate: Column {
                    id: col
                    required property var modelData
                    spacing: 8
                    // Wide enough for "Session 5h: 12% · 4h 30m · 0/4000 calls"
                    width: 240

                    StyledPopupHeaderRow {
                        icon: col.modelData.id === "openai" ? "smart_toy"
                            : col.modelData.id === "zai" ? "token" : "bolt"
                        label: {
                            const name = root.shortId(col.modelData.id)
                            return col.modelData.plan ? (name + " · " + col.modelData.plan) : name
                        }
                    }

                    Column {
                        spacing: 4
                        width: parent.width
                        visible: !!col.modelData.ok

                        StyledPopupValueRow {
                            icon: "percent"
                            label: "Used:"
                            value: col.modelData.usedPercent != null
                                ? (Math.round(col.modelData.usedPercent) + "%")
                                : "—"
                        }

                        Repeater {
                            model: col.modelData.windows || []
                            delegate: StyledPopupValueRow {
                                id: winRow
                                required property var modelData
                                icon: "timelapse"
                                label: (winRow.modelData.label || "?") + ":"
                                value: {
                                    if (winRow.modelData.usedPercent != null) {
                                        const reset = root.formatReset(winRow.modelData)
                                        const note = winRow.modelData.note ? (" · " + winRow.modelData.note) : ""
                                        return Math.round(winRow.modelData.usedPercent) + "% · " + reset + note
                                    }
                                    return winRow.modelData.note || "—"
                                }
                            }
                        }
                    }

                    Column {
                        spacing: 4
                        width: parent.width
                        visible: !col.modelData.ok
                        StyledPopupValueRow {
                            icon: "error"
                            label: "Error:"
                            value: col.modelData.error || "unknown"
                        }
                    }
                }
            }

            Column {
                visible: !root.ready || (root.providers || []).length === 0
                spacing: 6
                StyledPopupHeaderRow {
                    icon: "hourglass_empty"
                    label: "LLM Usage"
                }
                StyledPopupValueRow {
                    icon: "info"
                    label: "Status:"
                    value: root.lastError || "Loading…"
                }
            }
        }
    }
}
