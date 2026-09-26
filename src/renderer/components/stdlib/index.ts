import AddressBar from './AddressBar.vue'
import TabStrip from './TabStrip.vue'
import BookmarksBar from './BookmarksBar.vue'
import DropdownMenu from './DropdownMenu.vue'
import HistoryView from './HistoryView.vue'
import SettingsPage from './SettingsPage.vue'
import WindowControls from './WindowControls.vue'
import { registerComponent } from '../../core/registry'

// Стандартная библиотека конструктора. Все компоненты доступны глобально.
export function registerStdlib() {
  registerComponent('AddressBar', AddressBar, { description: 'Address bar with navigation' })
  registerComponent('TabStrip', TabStrip, { description: 'Tab strip with closable tabs' })
  registerComponent('BookmarksBar', BookmarksBar, { description: 'Bookmarks bar' })
  registerComponent('DropdownMenu', DropdownMenu, { description: 'Dropdown menu with actions' })
  registerComponent('HistoryView', HistoryView, { description: 'Browsing history' })
  registerComponent('SettingsPage', SettingsPage, { description: 'Browser settings page' })
  registerComponent('WindowControls', WindowControls, {
    description: 'Window buttons: minimize, maximize, close'
  })
}

export { AddressBar, TabStrip, BookmarksBar, DropdownMenu, HistoryView, SettingsPage, WindowControls }
