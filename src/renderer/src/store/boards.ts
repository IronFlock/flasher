import { defineStore } from 'pinia'
import { IronFlockOSCatalogStatus, SupportedBoard } from 'src/types'

type BoardStoreState = {
  items: SupportedBoard[]
  // undefined while loading
  ironflockos: IronFlockOSCatalogStatus | undefined
  initialized: boolean
}

export const useBoardStore = () => {
  const store = defineStore('board', {
    state: (): BoardStoreState => ({ items: [], ironflockos: undefined, initialized: false }),
    getters: { boards: (state) => state.items },
    actions: {
      initialize() {
        this.initialized = true
        this.refresh()
      },
      // Asks for the boards whenever they are shown. The main process fetches
      // the catalog again when its last load is more than 5 minutes old, or now
      // with `force` (the retry after an error); it keeps the boards verified
      // before when a refresh fails.
      async refresh(force = false): Promise<void> {
        try {
          const { boards, ironflockos } = await window.api.getSupportedBoards(force)
          if (JSON.stringify(boards) !== JSON.stringify(this.items)) this.items = boards
          this.ironflockos = ironflockos
        } catch (error: any) {
          console.error('Failed to load the board catalog:', error)
          this.ironflockos = {
            ok: false,
            code: 'unreachable',
            error: String(error?.message ?? error)
          }
        }
      }
    }
  })

  const BoardStore = store()
  if (!BoardStore.initialized) {
    BoardStore.initialize()
  }

  return BoardStore
}
