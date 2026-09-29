"""Three-person group video call (mesh): everyone should see two remote tiles."""
import os, time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'http://localhost:3100')
OUT = os.environ.get('OUT', '/tmp/shots')

def signup(page, name, username):
    page.goto(BASE)
    page.get_by_role('tab', name='Create account').click()
    page.get_by_label('Your name').fill(name)
    page.get_by_label('Username').fill(username)
    page.get_by_label('Password').fill('password123')
    page.get_by_role('button', name='Create account').click()
    expect(page.locator('.shell')).to_be_visible()

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    pages = []
    for name, user in [('Ana Villanueva', 'ana'), ('Lia Santos', 'lia'), ('Theo Ramos', 'theo')]:
        ctx = browser.new_context(viewport={'width': 1200, 'height': 800}, permissions=['microphone', 'camera'])
        pg = ctx.new_page()
        signup(pg, name, user)
        pages.append(pg)
    a, b, c = pages
    a.get_by_role('button', name='New message').first.click()
    for u in ['lia', 'theo']:
        a.get_by_placeholder('Search by name or username').fill(u)
        a.locator('[data-pick]', has_text='@' + u).click()
    a.locator('#nc-title-input').fill('Weekend Squad')
    a.locator('#nc-go').click()
    expect(a.locator('.who-name')).to_have_text('Weekend Squad')
    print('ok - group created')
    a.locator('#composer-input').fill('Group call in 1 min')
    a.keyboard.press('Enter')
    expect(b.locator('.row').first).to_contain_text('Weekend Squad')
    print('ok - group message delivered')

    a.get_by_role('button', name='Start video call').click()
    expect(b.locator('.call.incoming')).to_be_visible(timeout=10000)
    expect(c.locator('.call.incoming')).to_be_visible(timeout=10000)
    b.locator('.call.incoming .accept').click()
    expect(a.locator('.tile.has-video')).to_have_count(1, timeout=15000)
    c.locator('.call.incoming .accept').click()
    for pg, who in [(a, 'Ana'), (b, 'Lia'), (c, 'Theo')]:
        expect(pg.locator('.tile.has-video')).to_have_count(2, timeout=20000)
        print(f'ok - {who} sees 2 remote videos')
    time.sleep(1)
    c.screenshot(path=f'{OUT}/11-group-call.png')
    b.get_by_role('button', name='End call').click()
    expect(a.locator('.tile')).to_have_count(1, timeout=10000)
    print('ok - call continues after one person leaves')
    a.get_by_role('button', name='End call').click()
    expect(c.locator('.call.session')).to_have_count(0, timeout=10000)
    print('ok - call ends when one person is left')
    browser.close()
print('\nGroup call checks passed')
