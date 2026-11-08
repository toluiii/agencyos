import { Page, expect } from '@playwright/test';
export async function login(page: Page, email: string, password = 'DemoPass123!') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/(dashboard|portal)/, { timeout: 20000 });
}
export async function logout(page: Page) { await page.getByTitle('Sign out').click(); await expect(page).toHaveURL(/\/login/); }
export const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
