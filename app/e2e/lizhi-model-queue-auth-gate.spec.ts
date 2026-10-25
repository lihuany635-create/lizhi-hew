import {expect,test} from '@playwright/test'

test('M3 browser queue fails closed without trusted same-origin LizhiAuth',async({page})=>{
  await page.goto('/?lizhi-model-queue-pilot=1')
  const pilot=page.getByRole('complementary',{name:'Lizhi model authenticated queue pilot'})
  await expect(pilot).toBeVisible()
  await expect(pilot.getByRole('button',{name:'斷開 AI 連線'})).toHaveCount(0)
  await pilot.getByRole('button',{name:'連線 AI（30 分鐘）'}).click()
  await expect(pilot.getByRole('status')).toContainText('缺少同源驗證登入')
  await expect(pilot.getByRole('button',{name:'斷開 AI 連線'})).toHaveCount(0)
})
