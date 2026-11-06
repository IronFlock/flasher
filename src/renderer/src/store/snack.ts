import { defineStore } from 'pinia'

type SnackStoreState = {
  initialized: boolean
  _text: string
  // _text is shown as it is, not looked up as a translation key
  _raw: boolean
  _visible: boolean
  _color: string
}

export const useSnackStore = () => {
  const store = defineStore('snack', {
    state: (): SnackStoreState => ({
      initialized: false,
      _visible: false,
      _text: '',
      _raw: false,
      _color: 'primary'
    }),
    getters: {
      text: (state) => state._text,
      raw: (state) => state._raw,
      color: (state) => state._color,
      visible: (state) => state._visible
    },
    actions: {
      async initialize() {
        this.initialized = true
      },
      setColor(color: string) {
        this._color = color
      },
      setVisible(visible: boolean) {
        this._visible = visible

        if (this._visible) {
          setTimeout(() => {
            this._visible = false
          }, 5000)
        }
      },
      setText(text: string) {
        this._text = text
        this._raw = false
      },
      // A message from elsewhere (an error), shown untranslated.
      setRawText(text: string) {
        this._text = text
        this._raw = true
      }
    }
  })

  const Snacktore = store()
  if (!Snacktore.initialized) {
    Snacktore.initialize()
  }

  return Snacktore
}
