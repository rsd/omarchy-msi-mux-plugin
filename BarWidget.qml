import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// MSI GPU MUX: the MUX mode of an MSI laptop as a GPU glyph in the bar (a
// badge while a switch waits for a full shutdown) and a panel on click.
//
// State comes from MuxState.qml, a singleton shared by every bar (see that
// file for what runs when). This file lays the state out and asks for the
// user's actions; every string, verdict and argv is in Model.js.
//
// Actions:
//   - Switch: a confirmation dialog first (naming the mode and the full
//     shutdown, plus the external-screen warning for Integrated unless the
//     setting turns it off), then MuxState.requestSwitch, which checks
//     ownership and AC again and runs pkexec. On success, a second dialog
//     offers Shut down now (`omarchy-system shutdown`) or Later. While a
//     switch is staged no mode has a button: it can be neither replaced nor
//     cancelled before a full shutdown (Model.STAGED_LOCK_TEXT says so).
//   - Hyprland base GPU (shown in every mode; acts only in MSHybrid):
//     MuxState.setEnvChoice, which writes or removes
//     ~/.config/uwsm/env.d/90-msi-mux-gpu only.
//   - Set up backend: the plugin's setup.sh in a floating terminal
//     (Model.setupArgv), with the binary path as an argument.
//
// Keyboard: as in the shell's own panels (PanelKeyCatcher). The first key
// press shows a cursor; Up/Down (or j/k, Left/Right) move it through the
// enabled controls (Model.cursorStops), Enter or Space activates the one
// under it, Esc closes, Tab moves to the next panel. With a dialog open,
// Left/Right/Tab pick its button, Enter activates it and Esc dismisses it.
//
// Every Text here declares textFormat: Text.PlainText (tool messages are
// shown); the model test checks each Text block for its own declaration.
Panel {
  id: root
  moduleName: "io.github.rsd.msi-mux"
  ipcTarget: "io.github.rsd.msi-mux"

  // ------------------------------------------------------------- state

  readonly property string binaryPath: Model.binaryPathSetting(root.setting("binaryPath", ""))
  readonly property bool warnIntegrated: Model.warnSetting(root.setting("warnBeforeIntegrated", true))
  onBinaryPathChanged: MuxState.setBinaryPath(root.binaryPath)

  readonly property var view: ({
    available: MuxState.available,
    debug: MuxState.debug,
    unavailableReason: MuxState.unavailableReason,
    busy: MuxState.busy,
    ac: MuxState.ac
  })
  readonly property var glyph: Model.barState(root.view)
  readonly property var rows: Model.modeRows(root.view)

  // The badge's size follows the bar glyph (12 when the shell has none).
  readonly property real barIconSize: {
    var s = Number(Style.bar.iconSize)
    return isFinite(s) && s > 0 ? s : 12
  }

  // The dialogs: which mode is being confirmed, and the shutdown offer.
  property string confirmMode: ""
  property bool shutdownOffered: false

  // The panel reopening itself to show a finished switch keeps the result;
  // any other opening clears a result already seen.
  property bool reopenForOutcome: false

  // Keyboard cursor (see Model.cursorStops): off until the first key press
  // after opening; the mouse moves it too, so one control is highlighted at
  // a time.
  property bool cursorActive: false
  property string cursorKey: ""
  readonly property var cursorStops: Model.cursorStops(root.rows, { canSetUp: MuxState.canSetUp })
  readonly property string cursorAt: Model.cursorKeyIn(root.cursorStops, root.cursorKey)
  readonly property bool dialogOpen: confirmDialog.opened || shutdownDialog.opened

  // ------------------------------------------------------------- style

  readonly property color foreground: root.bar ? root.bar.foreground : Commons.Color.foreground
  readonly property color urgent: root.bar ? root.bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(root.foreground, 1.4)
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  // ------------------------------------------------------------- actions

  function askSwitch(row) {
    if (!row || row.action === "" || !row.enabled) return
    root.confirmMode = row.mode
    confirmDialog.selectedIndex = 0
  }

  // The row is checked again: the state may have changed while the dialog
  // was open (a switch staged, AC unplugged); then nothing runs.
  function confirmSwitch() {
    var mode = root.confirmMode
    root.confirmMode = ""
    var row = root.rows.find(function(r) { return r.mode === mode })
    if (!row || row.action !== "switch" || !row.enabled) return
    MuxState.requestSwitch(root, mode)
  }

  function shutDownNow() {
    root.shutdownOffered = false
    Quickshell.execDetached(Model.SHUTDOWN_ARGV)
  }

  // setup.sh runs in a terminal that stays open on its result; the panel
  // closes so the terminal gets the focus, and the next opening checks the
  // binary again.
  function setUpBackend() {
    if (!MuxState.canSetUp) return
    var argv = Model.setupArgv(MuxState.pluginDir, MuxState.binaryPath)
    if (argv.length === 0) return
    Quickshell.execDetached(argv)
    root.close()
  }

  // --------------------------------------------------------------- cursor

  function pointAt(key) {
    root.cursorActive = true
    root.cursorKey = key
  }

  function moveCursor(dx, dy) {
    root.cursorKey = Model.stepCursor(root.cursorStops, root.cursorAt, dx, dy)
  }

  function activateCursor() {
    var a = Model.cursorAction(root.cursorAt)
    if (a.kind === "setup") root.setUpBackend()
    else if (a.kind === "env") envDropdown.open()
    else if (a.kind === "mode") {
      for (var i = 0; i < root.rows.length; i++)
        if (root.rows[i].mode === a.arg) root.askSwitch(root.rows[i])
    }
  }

  // The open dialog's buttons: Left/Right/Tab toggle, Enter or Space picks,
  // Esc dismisses.
  function dialogKey(dialog, what) {
    if (what === "toggle") dialog.selectedIndex = dialog.selectedIndex === 0 ? 1 : 0
    else if (what === "activate") {
      if (dialog.selectedIndex === 0) dialog.canceled()
      else dialog.confirmed()
    } else if (what === "close") dialog.canceled()
  }

  function openDialog() {
    return confirmDialog.opened ? confirmDialog : (shutdownDialog.opened ? shutdownDialog : null)
  }

  // The control under the cursor is kept inside the visible part of the
  // panel.
  function scrollItemIntoView(item) {
    if (!item) return
    Qt.callLater(function() {
      if (!item || !item.visible) return
      var margin = Style.space(6)
      var top = item.mapToItem(panelFlick.contentItem, 0, 0).y
      var bottom = top + item.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < panelFlick.contentY + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > panelFlick.contentY + panelFlick.height - margin)
        panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  function syncEnvDropdown() {
    if (!envDropdown) return
    envDropdown.value = MuxState.envChoice === "modified" ? "" : MuxState.envChoice
  }

  Component.onCompleted: MuxState.attach(root, root.binaryPath)
  Component.onDestruction: MuxState.detach(root)

  onOpenedChanged: {
    if (root.opened) {
      root.cursorActive = false
      panelFlick.contentY = 0
      if (root.reopenForOutcome) root.reopenForOutcome = false
      else if (!MuxState.busy) MuxState.clearOutcome()
      MuxState.holdOpen(root)
      root.syncEnvDropdown()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      return
    }
    MuxState.releaseOpen(root)
    root.confirmMode = ""
    root.shutdownOffered = false
  }

  // A finished switch this widget asked for: the panel shows the result
  // (it may have closed while the polkit prompt had the focus) and, after a
  // staged switch, the shutdown offer.
  Connections {
    target: MuxState
    function onSwitchFinished(owner, outcome) {
      if (owner !== root) return
      if (!root.opened) {
        root.reopenForOutcome = true
        root.open()
      }
      if (outcome && outcome.offerShutdown) {
        shutdownDialog.selectedIndex = 0
        root.shutdownOffered = true
      }
    }
    function onEnvChoiceChanged() { root.syncEnvDropdown() }
    function onEnvRead() { root.syncEnvDropdown() }
  }

  // ------------------------------------------------------------ bar button

  // Hidden on non-MSI hardware (and until the DMI read says which).
  visible: !MuxState.hidden
  implicitWidth: MuxState.hidden ? 0 : button.implicitWidth
  implicitHeight: MuxState.hidden ? 0 : button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph.icon
    dimmed: root.glyph.dimmed
    tooltipText: Model.tooltipText(root.view)
    onPressed: function(b) { root.toggle() }

    // The pending mark: a small dot in the glyph's colour with a 1 px ring in
    // the surface colour, on the glyph box's upper-right corner.
    BorderSurface {
      readonly property real size: Math.max(7, Math.round(root.barIconSize * 0.42))
      visible: root.glyph.badge
      width: size
      height: size
      radius: size / 2
      color: button.foreground
      borderSpec: Border.flat(Commons.Color.popups.background, 1)
      x: Math.max(0, Math.min(button.width - size, Math.round(button.width / 2 + root.barIconSize / 2 - size / 2)))
      y: Math.max(0, Math.min(button.height - size, Math.round(button.height / 2 - root.barIconSize / 2 - size / 2)))
    }
  }

  // ----------------------------------------------------------------- panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    // Tall enough for a dialog even when the content is short.
    contentHeight: panel.fittedContentHeight(Math.max(column.implicitHeight,
      root.confirmMode !== "" || root.shutdownOffered ? Style.space(300) : 0))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // The dropdown's own list takes the keys while it is open.
      blocked: envDropdown.popupOpen
      // The first key press only shows the cursor, as in the shell's panels.
      onMoveRequested: function(dx, dy) {
        var d = root.openDialog()
        if (d) { if (dx !== 0) root.dialogKey(d, "toggle"); return }
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: {
        var d = root.openDialog()
        if (d) root.dialogKey(d, "activate")
        else if (!root.cursorActive) root.cursorActive = true
        else root.activateCursor()
      }
      onCloseRequested: {
        var d = root.openDialog()
        if (d) root.dialogKey(d, "close")
        else root.close()
      }
      onTabRequested: function(direction) {
        var d = root.openDialog()
        if (d) root.dialogKey(d, "toggle")
        else root.switchPanel(direction)
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar {
          id: panelScroll
          policy: ScrollBar.AsNeeded
        }

        Column {
          id: column
          width: panelFlick.width - (panelFlick.interactive ? panelScroll.width + Style.space(6) : 0)
          spacing: Style.space(10)

          PanelHero {
            width: parent.width
            title: Model.DISPLAY_NAME
            meta: Model.summary(MuxState.debug)
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: root.glyph.dimmed ? 0.5 : 1.0
            iconComponent: Component {
              Text {
                text: root.glyph.icon
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
          }

          // Why switching is unavailable, and the way out when there is one.
          Column {
            visible: MuxState.unavailableReason !== ""
            width: parent.width
            spacing: Style.space(6)

            Text {
              width: parent.width
              text: MuxState.unavailableReason
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              visible: MuxState.canSetUp
              width: parent.width
              text: "Set up backend makes the binary and its folder root-owned (sudo, in a terminal, after you confirm). Building msi-mux-switch is covered in the plugin's README."
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Button {
              id: setupButton
              visible: MuxState.canSetUp
              anchors.right: parent.right
              text: "Set up backend"
              iconText: Model.ICON.setup
              tooltipText: "Runs the plugin's setup.sh in a terminal"
              hasCursor: root.cursorActive && root.cursorAt === "setup"
              onHasCursorChanged: if (setupButton.hasCursor) root.scrollItemIntoView(setupButton)
              onHovered: function(isHovered) { if (isHovered) root.pointAt("setup") }
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              bordered: true
              onClicked: root.setUpBackend()
            }
          }

          Text {
            visible: MuxState.debug.error !== "" && MuxState.unavailableReason === ""
            width: parent.width
            text: MuxState.debug.error
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            width: parent.width
            text: Model.ICON.power + "  " + Model.acText(MuxState.ac)
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: MuxState.ac === true ? root.dim : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          PanelSeparator { foreground: root.foreground }

          PanelSectionHeader {
            text: "MODES"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Repeater {
            model: root.rows
            ModeRow {
              required property var modelData
              width: column.width
              row: modelData
            }
          }

          // A staged switch locks the mode until a full shutdown. Hidden while
          // the result below already says the same sentence (a refused switch).
          Text {
            visible: MuxState.debug.ok && MuxState.debug.pending
              && !(!MuxState.busy && MuxState.outcome !== null && MuxState.outcome.message === Model.STAGED_LOCK_TEXT)
            width: parent.width
            text: Model.STAGED_LOCK_TEXT
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // The last switch's result; the trigger warning stands out.
          Column {
            visible: MuxState.outcome !== null || MuxState.busy
            width: parent.width
            spacing: Style.space(4)

            Text {
              width: parent.width
              text: MuxState.busy
                ? (MuxState.phase === "checking" ? "Checking the backend and AC power…" : "Switching: waiting for authentication and the firmware…")
                : (MuxState.outcome ? MuxState.outcome.message : "")
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: !MuxState.busy && MuxState.outcome && MuxState.outcome.kind === "error" ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              visible: !MuxState.busy && MuxState.outcome !== null && MuxState.outcome.warning !== ""
              width: parent.width
              text: MuxState.outcome ? MuxState.outcome.warning : ""
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          // Hyprland's base GPU: shown and usable in every mode, current or
          // pending; the file it writes acts only in MSHybrid.
          Column {
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { foreground: root.foreground }

            // Its value follows MuxState.envChoice (syncEnvDropdown): a
            // pick sets it imperatively, so it is not a binding.
            Dropdown {
              id: envDropdown
              width: parent.width
              label: "Hyprland base GPU (MSHybrid)"
              options: Model.ENV_OPTIONS
              foreground: root.foreground
              fontFamily: root.fontFamily
              hasCursor: root.cursorActive && root.cursorAt === "env"
              onHasCursorChanged: if (envDropdown.hasCursor) root.scrollItemIntoView(envDropdown)
              onHovered: function(isHovered) { if (isHovered) root.pointAt("env") }
              onChanged: function(value) { MuxState.setEnvChoice(value) }
              Component.onCompleted: root.syncEnvDropdown()
            }

            Text {
              width: parent.width
              text: "Auto leaves Hyprland's config untouched. Intel or RTX writes ~/.config/uwsm/env.d/" + Model.ENV_FILE_NAME
                + ". It takes effect only in MSHybrid, after you log out and back in; in Discrete or Integrated the file is inert."
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              visible: MuxState.envChoice === "modified"
              width: parent.width
              text: Model.ENV_MODIFIED_TEXT
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              visible: MuxState.envChanged || MuxState.envError !== ""
              width: parent.width
              text: MuxState.envError !== "" ? MuxState.envError : Model.envStatusText(MuxState.debug)
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: MuxState.envError !== "" ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }
      }

      ConfirmDialog {
        id: confirmDialog
        anchors.fill: parent
        z: 10
        opened: root.confirmMode !== ""
        message: Model.confirmMessage(root.confirmMode, root.warnIntegrated)
        cancelText: "Cancel"
        confirmText: "Switch"
        fontFamily: root.fontFamily
        onCanceled: root.confirmMode = ""
        onConfirmed: root.confirmSwitch()
      }

      ConfirmDialog {
        id: shutdownDialog
        anchors.fill: parent
        z: 11
        opened: root.shutdownOffered && root.confirmMode === ""
        message: Model.SHUTDOWN_MESSAGE
        cancelText: "Later"
        confirmText: "Shut down now"
        fontFamily: root.fontFamily
        onCanceled: root.shutdownOffered = false
        onConfirmed: root.shutDownNow()
      }
    }
  }

  // ------------------------------------------------------------ components

  // One mode: glyph, name, description, its status, and its button.
  component ModeRow: RowLayout {
    id: modeRow
    property var row: null
    spacing: Style.space(8)

    Text {
      text: modeRow.row ? modeRow.row.icon : ""
      textFormat: Text.PlainText
      color: modeRow.row && modeRow.row.mode === MuxState.debug.current ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.icon
      Layout.alignment: Qt.AlignTop
    }

    ColumnLayout {
      Layout.fillWidth: true
      spacing: Style.space(1)

      Text {
        Layout.fillWidth: true
        text: modeRow.row ? modeRow.row.label : ""
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: modeRow.row !== null && modeRow.row.mode === MuxState.debug.current
        elide: Text.ElideRight
      }

      Text {
        Layout.fillWidth: true
        text: modeRow.row ? modeRow.row.description : ""
        textFormat: Text.PlainText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
      }

      Text {
        Layout.fillWidth: true
        visible: text !== ""
        text: modeRow.row ? modeRow.row.status : ""
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
      }

      // Why this row cannot switch now (a disabled Button shows no tooltip).
      Text {
        Layout.fillWidth: true
        visible: text !== ""
        text: modeRow.row ? modeRow.row.reason : ""
        textFormat: Text.PlainText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.italic: true
        wrapMode: Text.Wrap
      }
    }

    Button {
      id: modeButton
      readonly property string key: modeRow.row ? "mode|" + modeRow.row.mode : ""
      visible: modeRow.row !== null && modeRow.row.action !== ""
      hasCursor: root.cursorActive && root.cursorAt === modeButton.key
      onHasCursorChanged: if (modeButton.hasCursor) root.scrollItemIntoView(modeRow)
      onHovered: function(isHovered) { if (isHovered && modeButton.enabled) root.pointAt(modeButton.key) }
      text: modeRow.row ? modeRow.row.buttonText : ""
      enabled: modeRow.row !== null && modeRow.row.enabled
      opacity: enabled ? 1 : 0.45
      foreground: root.foreground
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      bordered: true
      Layout.alignment: Qt.AlignVCenter
      onClicked: root.askSwitch(modeRow.row)
    }
  }
}
