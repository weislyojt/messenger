"""End-to-end browser test: two users chat, share media, record a voice note and video call."""
import os, sys, time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'http://localhost:3100')
OUT = os.environ.get('OUT', '/tmp/shots')
os.makedirs(OUT, exist_ok=True)
errors = []

def ok(msg):
    print('ok -', msg, flush=True)

def track(page, name):
    page.on('console', lambda m: errors.append(f'[{name}] {m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'[{name}] pageerror: {e}'))

def signup(page, name, username):
    page.goto(BASE)
    page.get_by_role('tab', name='Create account').click()
    page.get_by_label('Your name').fill(name)
    page.get_by_label('Username').fill(username)
    page.get_by_label('Password').fill('password123')
    page.get_by_role('button', name='Create account').click()
    expect(page.locator('.shell')).to_be_visible()

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
    ])
    ctxA = browser.new_context(viewport={'width': 1360, 'height': 860}, permissions=['microphone', 'camera'])
    ctxB = browser.new_context(viewport={'width': 1360, 'height': 860}, permissions=['microphone', 'camera'])
    a = ctxA.new_page(); track(a, 'A')
    b = ctxB.new_page(); track(b, 'B')

    signup(a, 'Mika Reyes', 'mika')
    signup(b, 'Jun Park', 'jun')
    ok('both users signed up')
    a.screenshot(path=f'{OUT}/01-empty.png')

    # Start a chat
    a.get_by_role('button', name='New message').first.click()
    a.get_by_placeholder('Search by name or username').fill('jun')
    a.locator('[data-pick]', has_text='@jun').click()
    a.locator('#nc-go').click()
    expect(a.locator('.who-name')).to_have_text('Jun Park')
    ok('conversation opened')

    a.locator('#composer-input').fill('Morning! Still on for Batangas this Saturday?')
    a.keyboard.press('Enter')
    expect(a.locator('.msg.mine .bubble').last).to_have_text('Morning! Still on for Batangas this Saturday?')
    expect(b.locator('.row').first).to_contain_text('Mika Reyes')
    expect(b.locator('.row .badge').first).to_have_text('1')
    ok('B sees new chat with unread badge')

    b.locator('.row').first.click()
    expect(b.locator('.msg.theirs .bubble').last).to_have_text('Morning! Still on for Batangas this Saturday?')
    expect(a.locator('.status').last).to_contain_text('Seen')
    ok('read receipt shows Seen')

    # Typing indicator
    b.locator('#composer-input').type('Yes! Leaving at 6', delay=30)
    expect(a.locator('.typing')).to_be_visible()
    ok('typing indicator')
    b.keyboard.press('Enter')
    expect(a.locator('.msg.theirs .bubble').last).to_have_text('Yes! Leaving at 6')
    ok('reply delivered')

    # Photo upload
    png = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'icon-512.png')
    a.locator('#pick-media').set_input_files(png)
    expect(b.locator('.msg.theirs .media.img img')).to_be_visible()
    ok('photo delivered')

    # File upload
    a.locator('#pick-file').set_input_files({'name': 'itinerary.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 test file'})
    expect(b.locator('.file .file-name').last).to_have_text('itinerary.pdf')
    ok('file delivered')

    # Reaction
    msg = b.locator('.msg.theirs').filter(has=b.locator('.bubble', has_text='Morning!'))
    msg.hover()
    msg.locator('.more-btn').click()
    b.get_by_role('button', name='Love').click()
    expect(a.locator('.reacts').first).to_be_visible()
    ok('reaction delivered')

    # Reply
    msg.hover()
    msg.locator('.more-btn').click()
    b.get_by_role('menuitem', name='Reply').click()
    b.locator('#composer-input').fill('Bringing the speaker')
    b.keyboard.press('Enter')
    expect(a.locator('.quote').last).to_contain_text('Morning!')
    ok('reply with quote delivered')

    # Voice note (fake microphone)
    b.get_by_role('button', name='Record a voice message').click()
    expect(b.locator('#rec-row')).to_be_visible()
    time.sleep(2.2)
    b.get_by_role('button', name='Send voice message').click()
    expect(a.locator('.msg.theirs .voice').last).to_be_visible(timeout=10000)
    ok('voice message delivered')
    a.locator('.msg.theirs .voice .vplay').last.click()
    time.sleep(0.8)
    playing = a.evaluate("() => { const v = document.querySelector('.msg.theirs .voice .vplay'); return v && v.dataset.state; }")
    ok(f'voice playback state: {playing}')

    a.screenshot(path=f'{OUT}/02-chat-A.png')
    b.screenshot(path=f'{OUT}/03-chat-B.png')

    # Video call A -> B
    a.get_by_role('button', name='Start video call').click()
    expect(b.locator('.call.incoming')).to_be_visible(timeout=10000)
    time.sleep(0.4)
    b.screenshot(path=f'{OUT}/04-incoming.png')
    ok('incoming call ringing on B')
    b.locator('.call.incoming .accept').click()
    expect(a.locator('.tile.has-video')).to_be_visible(timeout=15000)
    expect(b.locator('.tile.has-video')).to_be_visible(timeout=15000)
    ok('video connected both ways')
    time.sleep(1.5)
    states = a.evaluate("() => [...document.querySelectorAll('.tile video')].map(v => ({w: v.videoWidth, h: v.videoHeight}))")
    ok(f'remote video size on A: {states}')
    a.screenshot(path=f'{OUT}/05-call-A.png')
    b.get_by_role('button', name='Mute microphone').click()
    expect(a.locator('.tile .tn-mic')).to_be_visible()
    ok('mute state shown to peer')
    b.get_by_role('button', name='Turn camera off').click()
    expect(a.locator('.tile:not(.has-video)')).to_be_visible()
    ok('camera-off shows avatar to peer')
    b.screenshot(path=f'{OUT}/06-call-B.png')
    a.get_by_role('button', name='End call').click()
    expect(b.locator('.call.session')).to_have_count(0, timeout=10000)
    expect(a.locator('.callmsg').last).to_contain_text('Video call')
    ok('call ended and logged in chat')

    # Audio call declined
    a.get_by_role('button', name='Start audio call').click()
    expect(b.locator('.call.incoming')).to_be_visible(timeout=10000)
    b.locator('.call.incoming .decline').click()
    expect(a.locator('.hero-status')).to_have_text('Call declined', timeout=10000)
    ok('declined call shows on caller')
    time.sleep(2.2)

    # Calls tab
    b.goto(BASE + '/calls')
    expect(b.locator('.row').first).to_be_visible()
    b.screenshot(path=f'{OUT}/07-calls.png')
    ok('call history renders')

    # Mobile layout
    m = browser.new_context(viewport={'width': 390, 'height': 844}, permissions=['microphone', 'camera'], is_mobile=True, has_touch=True, storage_state=ctxA.storage_state())
    mp = m.new_page(); track(mp, 'M')
    mp.goto(BASE)
    expect(mp.locator('.row').first).to_be_visible()
    mp.screenshot(path=f'{OUT}/08-mobile-list.png')
    mp.locator('.row').first.click()
    expect(mp.locator('.messages')).to_be_visible()
    time.sleep(0.6)
    mp.screenshot(path=f'{OUT}/09-mobile-chat.png')
    mp.get_by_role('link', name='Back to chats').click()
    expect(mp.locator('.row').first).to_be_visible()
    ok('mobile list and chat navigation')

    # Dark mode
    d = browser.new_context(viewport={'width': 1360, 'height': 860}, color_scheme='dark', storage_state=ctxB.storage_state())
    dp = d.new_page(); track(dp, 'D')
    dp.goto(BASE)
    dp.locator('.row').first.click()
    time.sleep(0.8)
    dp.screenshot(path=f'{OUT}/10-dark.png')
    ok('dark mode renders')

    browser.close()

real = [e for e in errors if 'favicon' not in e and 'net::ERR' not in e]
if real:
    print('\nConsole errors:')
    for e in real:
        print(' ', e)
    sys.exit(1)
print('\nAll browser checks passed')
