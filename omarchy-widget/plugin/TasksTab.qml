import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "TaskModel.js" as TaskModel

// Content of the Tasks tab: quick-add field, filter row, task list. Panel.qml owns the
// Calendar | Tasks tab bar and switches this whole component in and out of view; this file is
// only what shows underneath once Tasks is selected.
Column {
  id: root

  property var tasksData: null
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  // Exposed so Panel.qml can block its PanelKeyCatcher while the quick-add field has focus --
  // the same wiring root.editingLife already uses for the birth-year/life-expectancy fields.
  readonly property bool editing: quickAddField.activeFocus

  property string filterStatus: "open"
  property var filterBuckets: []
  property var filterCategories: []

  readonly property var bucketOptions: [
    { value: "overdue", label: "Overdue" },
    { value: "today", label: "Today" },
    { value: "week", label: "Week" },
    { value: "none", label: "No date" }
  ]

  readonly property var allTasks: root.tasksData && Array.isArray(root.tasksData.tasks) ? root.tasksData.tasks : []
  // Built from every loaded task, not the filtered set, so a chip never disappears out from
  // under the user just because another filter narrowed the list to zero of that category.
  readonly property var categoryOptions: TaskModel.categoryCounts(root.allTasks)
  readonly property var filtered: TaskModel.filterTasks(root.allTasks, {
    status: root.filterStatus,
    buckets: root.filterBuckets,
    categories: root.filterCategories,
    search: ""
  }, clock.date.getTime())
  readonly property var sorted: TaskModel.sortTasks(root.filtered, clock.date.getTime())

  function toggleBucket(value) {
    var idx = root.filterBuckets.indexOf(value)
    var next = root.filterBuckets.slice()
    if (idx === -1) next.push(value)
    else next.splice(idx, 1)
    root.filterBuckets = next
  }

  function toggleCategory(name) {
    var idx = root.filterCategories.indexOf(name)
    var next = root.filterCategories.slice()
    if (idx === -1) next.push(name)
    else next.splice(idx, 1)
    root.filterCategories = next
  }

  function submitQuickAdd() {
    var text = quickAddField.text
    if (String(text).trim() === "") return
    // Cleared immediately (optimistic); TasksData.addFailed puts it back if the POST fails.
    quickAddField.text = ""
    if (root.tasksData) root.tasksData.addTask(text, "")
  }

  spacing: Style.space(8)

  // Drives dueBucket/sort/row recomputation as minutes pass (a task due "today" must become
  // "overdue" the moment the calendar day rolls over, not just on the next poll).
  SystemClock {
    id: clock
    precision: SystemClock.Minutes
  }

  Connections {
    target: root.tasksData
    function onAddFailed(text) { quickAddField.text = text }
  }

  TextField {
    id: quickAddField
    width: parent.width
    placeholderText: "Add a task… e.g. call the bank @admin due:friday !1"
    foreground: root.foreground
    font.family: root.fontFamily
    onAccepted: root.submitQuickAdd()
    Keys.onEscapePressed: quickAddField.focus = false
  }

  // ---- filters --------------------------------------------------------------------------

  Column {
    width: parent.width
    spacing: Style.space(6)

    ButtonGroup {
      options: [
        { value: "open", label: "Open" },
        { value: "done", label: "Completed" },
        { value: "all", label: "All" }
      ]
      value: root.filterStatus
      focusable: false
      background: "transparent"
      foreground: root.foreground
      accent: Color.accent
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      onChanged: function(v) { root.filterStatus = v }
    }

    Flow {
      width: parent.width
      spacing: Style.space(4)

      Repeater {
        model: root.bucketOptions

        Button {
          required property var modelData

          text: modelData.label
          bordered: true
          selected: root.filterBuckets.indexOf(modelData.value) !== -1
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.bodySmall
          onClicked: root.toggleBucket(modelData.value)
        }
      }
    }

    Flow {
      visible: root.categoryOptions.length > 0
      width: parent.width
      spacing: Style.space(4)

      Repeater {
        model: root.categoryOptions

        Button {
          required property var modelData

          text: modelData.name + " (" + modelData.count + ")"
          bordered: true
          selected: root.filterCategories.indexOf(modelData.name) !== -1
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.bodySmall
          onClicked: root.toggleCategory(modelData.name)
        }
      }
    }
  }

  // ---- list -----------------------------------------------------------------------------

  Column {
    width: parent.width
    spacing: Style.space(2)

    Repeater {
      model: root.sorted

      TaskRow {
        required property var modelData

        width: parent.width
        tasksData: root.tasksData
        task: modelData
        nowMs: clock.date.getTime()
        foreground: root.foreground
        fontFamily: root.fontFamily
      }
    }
  }

  Text {
    textFormat: Text.PlainText
    visible: root.sorted.length === 0
    leftPadding: Style.space(8)
    // Two distinct messages: nothing loaded at all, versus filters narrowing a non-empty list to
    // nothing -- the fix for one ("add a task") is not the fix for the other ("clear a filter").
    text: root.allTasks.length === 0
      ? (root.tasksData && root.tasksData.loading ? "Loading…" : "No tasks")
      : "No tasks match these filters"
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Text {
    textFormat: Text.PlainText
    visible: text !== ""
    width: parent.width
    horizontalAlignment: Text.AlignHCenter
    elide: Text.ElideRight
    text: root.tasksData ? root.tasksData.statusText : ""
    color: Qt.darker(root.foreground, 1.5)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
