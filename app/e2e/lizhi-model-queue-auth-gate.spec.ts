import {expect,test} from '@playwright/test'

test('M3 browser queue fails closed without trusted same-origin LizhiAuth',async({page})=>{
  await page.goto('/?lizhi-model-queue-pilot=1')
  const pilot=page.getByRole('complementary',{name:'Lizhi model authenticated queue pilot'})
  await expect(pilot).toBeVisible()
  await expect(pilot.getByRole('button',{name:'領取並處理一筆工作'})).toBeDisabled()
  await pilot.getByRole('button',{name:'本人授權 120 秒'}).click()
  await expect(pilot.getByRole('status')).toContainText('缺少同源驗證登入')
  await expect(pilot.getByRole('button',{name:'領取並處理一筆工作'})).toBeDisabled()
})
