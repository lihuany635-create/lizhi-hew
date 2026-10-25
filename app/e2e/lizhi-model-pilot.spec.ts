import { expect, test } from '@playwright/test'

type HewHarness = {
  isReady(): boolean
  getObjectCount(): number
  getObjectIds(): string[]
  getObjectBounds(id: string): [number, number, number, number, number, number]
  isObjectSolid(id: string): boolean
}
const withHew = (window: Window): HewHarness | undefined =>
  (window as Window & { __hew_test?: HewHarness }).__hew_test

test('Lizhi manual local consent creates a real 1200 × 600 × 750 mm watertight Hew solid', async ({ page }) => {
  await page.goto('/?lizhi-model-pilot=1')
  await expect.poll(() => page.evaluate(() => withHew(window)?.isReady() ?? false)).toBe(true)
  const pilot = page.getByRole('complementary', { name: 'Lizhi model pilot' })
  await expect(pilot).toBeVisible()
  expect(await page.evaluate(() => withHew(window)?.getObjectCount())).toBe(0)
  const create = pilot.getByRole('button', { name: /1200.*600.*750/ })
  await expect(create).toBeDisabled()
  await pilot.getByRole('button', { name: '手動允許一次測試' }).click()
  await expect(create).toBeEnabled()
  await create.click()
  await expect(pilot.getByRole('status')).toContainText('succeeded:')
  await expect(create).toBeDisabled()

  await expect.poll(() => page.evaluate(() => withHew(window)?.getObjectCount())).toBe(1)
  const actual = await page.evaluate(() => {
    const harness = withHew(window)!
    const [id] = harness.getObjectIds()
    return { id, solid: harness.isObjectSolid(id), bounds: harness.getObjectBounds(id) }
  })
  expect(actual.solid).toBe(true)
  const expected = [0, 0, 0, 1.2, 0.6, 0.75]
  for (let i = 0; i < 6; i++) expect(actual.bounds[i]).toBeCloseTo(expected[i], 4)
})
