# 💬 Overlay UI

Документ описывает Vue-панели overlay-окна: корень, виды панелей, поиск, стили.

## 🧩 Корень

`OverlayRoot.vue` парсит payload из hash синхронно до первого рендера, ставит `dataset.theme` и класс `no-anim`. Пустой payload показывает ошибку. Клик по прозрачной области закрывает окно без выбора.

## 🗂️ Панели

`BrowserMenu.vue` рисует пункты и инкогнито-бейдж. Пункт группы показывает заданные иконку, название и цветную точку (`color`). `ToastStack.vue` показывает уведомления. `PromptDialog.vue` запрашивает ввод для переименования и цвета. `IconDialog.vue` — общий диалог иконки для вкладок и групп: поле ввода плюс кнопки URL, файл, emoji и отмена; тип источника верифицирует main (`verifyIconSource`). `FindBar.vue` висит над страницей с опциями как в VS Code.

```mermaid
flowchart LR
  Root[OverlayRoot payload] --> Kind{kind}
  Kind -->|menu| Menu[BrowserMenu]
  Kind -->|toast| Toast[ToastStack]
  Kind -->|dialog| Dialog[PromptDialog]
  Kind -->|find| Find[FindBar]
  Find -->|overlayAPI| Main[find:* в main]
  Menu -->|overlayAPI| Main
  Dialog -->|overlayAPI| Main
```

## 🔍 Поиск

`FindBar` шлет `findQuery`, `findNext`, `findPrev`, `findClose` через `window.overlayAPI`. Опции: `matchCase`, `wholeWord`, `useRegex`. Счетчик обновляется через `.find-count`.

## 🎨 Стили

`overlay.css` красит панели через те же переменные shell по `data-theme`. Анимация fade длится 60ms и отключается классом `no-anim`. Кастомные панели фиксируются классом `.theme-lock`.
