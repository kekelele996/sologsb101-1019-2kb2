/**
 * 补纸选配 store
 * 补纸挂在书叶下，写入时按所属册次做乐观修订号校验。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db } from '@/utils/db'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { isVolumeContentEditable, type Volume } from '@/types/volume'
import type { Paper, PaperDraft } from '@/types/paper'
import { commitVolumeChange, revisionOf, type VolumeSaveResult, type VolumeScopeSnapshot } from '@/utils/concurrency'

export interface PaperMutationOptions {
  expectedRevision: number
  baseline?: VolumeScopeSnapshot | null
}

export const usePaperStore = defineStore('paper', () => {
  const papers = ref<Paper[]>([])

  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  const sortedPapers = computed(() => [...papers.value].sort((a, b) => a.deltaE - b.deltaE))

  async function loadPapers(): Promise<void> {
    loading.value = true
    try {
      papers.value = await db.papers.toArray()
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '补纸读取失败'
    } finally {
      loading.value = false
    }
  }

  function paperForLeaf(leafId: string): Paper | undefined {
    return papers.value.find((paper) => paper.leafId === leafId)
  }

  function volumeForPaper(paperOrLeafId: Paper | string): Volume | undefined {
    const leafId = typeof paperOrLeafId === 'string' ? paperOrLeafId : paperOrLeafId.leafId
    const leaf = useLeafStore().leafById(leafId)
    if (!leaf) return undefined
    return useBookStore().volumeById(leaf.volumeId)
  }

  function requireWritableVolumeForLeaf(leafId: string): Volume {
    const volume = volumeForPaper(leafId)
    if (!volume) throw new Error('未找到对应册次')
    if (!isVolumeContentEditable(volume.state)) throw new Error('该册已装订或归档，不能修改补纸记录')
    return volume
  }

  async function createPaper(draft: PaperDraft, options: PaperMutationOptions): Promise<VolumeSaveResult> {
    const volume = requireWritableVolumeForLeaf(draft.leafId)
    const result = await commitVolumeChange(
      volume.id,
      options,
      async ({ now }) => {
        await db.papers.put({ ...draft, id: createId('paper'), createdAt: now, updatedAt: now })
      },
      options.baseline
    )
    if (result.ok) await loadPapers()
    return result
  }

  async function updatePaper(id: string, patch: Partial<Paper>, options?: PaperMutationOptions): Promise<VolumeSaveResult | null> {
    const existing = papers.value.find((paper) => paper.id === id)
    if (!existing) return null
    const volume = requireWritableVolumeForLeaf(existing.leafId)
    const result = await commitVolumeChange(
      volume.id,
      options ?? { expectedRevision: revisionOf(volume) },
      async ({ now }) => {
        await db.papers.put({ ...existing, ...patch, id, leafId: existing.leafId, createdAt: existing.createdAt, updatedAt: now })
      },
      options?.baseline
    )
    if (result.ok) await loadPapers()
    return result
  }

  async function removePaper(id: string, options?: PaperMutationOptions): Promise<VolumeSaveResult | null> {
    const existing = papers.value.find((paper) => paper.id === id)
    if (!existing) return null
    const volume = requireWritableVolumeForLeaf(existing.leafId)
    const result = await commitVolumeChange(
      volume.id,
      options ?? { expectedRevision: revisionOf(volume) },
      async () => {
        await db.papers.delete(id)
      },
      options?.baseline
    )
    if (result.ok) await loadPapers()
    return result
  }

  return {
    papers,
    sortedPapers,
    loading,
    ready,
    error,
    loadPapers,
    paperForLeaf,
    volumeForPaper,
    createPaper,
    updatePaper,
    removePaper
  }
})
