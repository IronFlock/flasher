import { defineStore } from 'pinia'
import { FlashItem, FlashState, Progress, ReswarmConfig, SupportedBoard } from 'src/types'
import { useDrivesStore } from './drives'
import { useBoardStore } from './boards'
import { deepToRaw } from '@renderer/utils'
import { useSnackStore } from './snack'
import {
  defaultImageKey,
  installerKeyFor,
  isConfigFileName,
  matchBoard,
  rebindChoice
} from '../../../shared/images'

// An Error from ipcRenderer.invoke reads "Error invoking remote method 'x': Error: <message>".
const remoteErrorMessage = (error: unknown): string =>
  String((error as Error)?.message ?? error).replace(
    /^Error invoking remote method '[^']*': (Error: )?/,
    ''
  )

type FlashStoreState = {
  items: FlashItem[]
  key: number
  initialized: boolean
}

const computeCanceledState = (state: FlashState): FlashState => {
  switch (state) {
    case 'flashing':
      return 'flashing-canceled'
    case 'verifying':
      return 'verification-canceled'
  }
  return state
}

export const useFlashStore = () => {
  const store = defineStore('flash', {
    state: (): FlashStoreState => ({ items: [], initialized: false, key: 0 }),
    getters: {
      flashItems: (state) => state.items,
      flashItemById: (state) => {
        return (id: number) => state.items.find((item) => item.id === id)
      }
    },
    actions: {
      // Adds a device file (.flock, .reswarm). FlockFlasher flashes the FlockOS
      // image chosen for it from the signed catalog; there are no local images.
      async addItem(fullPath: string) {
        const driveStore = useDrivesStore()
        const boardStore = useBoardStore()

        if (!isConfigFileName(fullPath)) {
          const snackstore = useSnackStore()
          snackstore.setText('errors.only_device_files')
          snackstore.setColor('error')
          snackstore.setVisible(true)
          return
        }

        const splitPath = fullPath.split('/')
        const fileName = splitPath.at(-1) as string
        const fileDirectory = splitPath.slice(0, -1).join('/')

        const fileType = fileName?.split('.').at(-1) as string
        const defaultDrive = driveStore.drives[0] ?? undefined

        const flashItem: FlashItem = {
          id: this.key++,
          fileDirectory,
          fileType,
          fullPath,
          fileName,
          flash: {
            progress: 0,
            state: 'idle',
            speed: 0,
            avgSpeed: 0,
            eta: 0
          },
          drive: defaultDrive
        }

        const configFileString = await window.api.readFile(fullPath)

        const config = JSON.parse(configFileString) as ReswarmConfig

        // Shows the boards, so the catalog is refreshed (at most every 5 minutes);
        // a .flock opened with FlockFlasher arrives before the first load ends.
        await boardStore.refresh()
        // The board the file asks for, or the one board of its architecture;
        // else none, and the user chooses. Only catalog boards are flashed.
        config.board = matchBoard(boardStore.boards, config)

        flashItem.reswarm = {
          configPath: fullPath,
          config,
          imageKey: defaultImageKey(config.board)
        }

        this.items.push(flashItem)
      },
      // The catalog changed: idle devices keep their board and image on the new
      // one; a device without a board gets the one its file asks for.
      rebindBoards(boards: SupportedBoard[]) {
        for (const item of this.items) {
          const config = item.reswarm?.config
          if (!item.reswarm || !config || item.flash.state !== 'idle') continue
          const choice = config.board
            ? rebindChoice(
                boards,
                config.board,
                item.reswarm.imageKey,
                item.reswarm.installerKey !== undefined
              )
            : { board: matchBoard(boards, config), imageKey: undefined, installerKey: undefined }
          config.board = choice.board
          item.reswarm.imageKey = choice.imageKey ?? defaultImageKey(choice.board)
          item.reswarm.installerKey = choice.installerKey
        }
      },
      // Chooses the hardware for a device file. Another hardware resets the
      // variant to its default (base, std kernel) and the installation to a
      // direct write; the same one keeps both.
      selectBoard(flashItem: FlashItem, board: SupportedBoard | undefined) {
        if (!flashItem.reswarm?.config) return
        const same = board && flashItem.reswarm.config.board?.model === board.model
        flashItem.reswarm.config.board = board
        if (!same) {
          flashItem.reswarm.imageKey = defaultImageKey(board)
          flashItem.reswarm.installerKey = undefined
        }
      },
      // Chooses the variant; the installer stick stays chosen only if it
      // carries the new variant, else the image is written directly.
      selectVariant(flashItem: FlashItem, key: string | undefined) {
        if (!flashItem.reswarm?.config) return
        flashItem.reswarm.imageKey = key
        if (flashItem.reswarm.installerKey !== undefined) {
          flashItem.reswarm.installerKey = installerKeyFor(flashItem.reswarm.config.board, key)
        }
      },
      // How to install: write the variant's image to the drive (false), or the
      // board's installer stick that carries it (true).
      selectInstallMethod(flashItem: FlashItem, useInstaller: boolean) {
        if (!flashItem.reswarm?.config) return
        flashItem.reswarm.installerKey = useInstaller
          ? installerKeyFor(flashItem.reswarm.config.board, flashItem.reswarm.imageKey)
          : undefined
      },
      async flashDevice(flashItem: FlashItem) {
        const snackstore = useSnackStore()

        if (!flashItem.drive) {
          snackstore.setText('errors.no_drive_selected')
          snackstore.setColor('error')
          snackstore.setVisible(true)
          return
        }

        if (
          flashItem.reswarm &&
          (!flashItem.reswarm.config?.board || !flashItem.reswarm.imageKey)
        ) {
          snackstore.setText('errors.no_image_selected')
          snackstore.setColor('error')
          snackstore.setVisible(true)
          return
        }

        await window.sudoDialog.openDialog()

        try {
          return await window.api.flashDevice(deepToRaw(flashItem))
        } catch (error) {
          // e.g. an image that is not in the verified catalog, or a failed download
          console.error('Flashing failed:', error)
          const item = this.items.find((i) => i.id === flashItem.id)
          if (item) item.flash.state = 'failed'
          snackstore.setRawText(remoteErrorMessage(error))
          snackstore.setColor('error')
          snackstore.setVisible(true)
        }
      },
      cancelFlashing(flashItem: FlashItem) {
        return window.api.cancelFlashing(flashItem.id)
      },
      reset(flashItem: FlashItem) {
        const item = this.items.find((i) => i.id === flashItem.id)
        if (item) {
          item.flash = {
            progress: 0,
            state: 'idle',
            speed: 0,
            avgSpeed: 0,
            eta: 0
          }
        }
      },
      removeItem(flashItem: FlashItem) {
        const flashItemIndex = this.items.findIndex((fi) => fi.id === flashItem.id)
        this.items.splice(flashItemIndex, 1)
      },
      initialize() {
        this.initialized = true

        document.body.addEventListener('dragover', (evt) => {
          evt.preventDefault()
        })

        document.body.addEventListener('drop', (evt) => {
          evt.preventDefault()

          // Electron 32+ removed File.path; resolve the dropped file's path via the
          // webUtils bridge exposed in the preload.
          const file = evt?.dataTransfer?.files[0]
          if (!file) return

          const filePath = window.api.getPathForFile(file)
          if (!filePath) return

          this.addItem(filePath)
        })

        window.ipcRenderer.receive('add-image-item', ({ filePath }: { filePath: string }) => {
          this.addItem(filePath)
        })

        window.ipcRenderer.receive(
          'flash-progress',
          ({ progress, id }: { progress: Progress; id: number }) => {
            const item = this.items.find((i) => i.id === id)
            if (!item) return

            if (progress.canceled) {
              item.flash = {
                progress: 0,
                state: computeCanceledState(progress.type),
                speed: 0,
                avgSpeed: 0,
                eta: 0
              }

              return
            }

            item.flash.state = progress.type
            item.flash.progress = progress.percentage ?? 0
            item.flash.speed = progress.speed ?? 0
            item.flash.eta = progress.eta ?? 0
            item.flash.avgSpeed = progress.averageSpeed ?? 0
          }
        )

        window.ipcRenderer.send('image-item-store-ready')
      }
    }
  })

  const FlashStore = store()
  if (!FlashStore.initialized) {
    FlashStore.initialize()
  }

  return FlashStore
}
