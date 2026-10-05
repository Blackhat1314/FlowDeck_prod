import asyncio, sys, time, os
from playwright.async_api import async_playwright
a, b = int(sys.argv[1]), int(sys.argv[2])
OUT='/tmp/claude-0/film/frames'
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await br.new_page(viewport={'width':1920,'height':1080})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:5173/film/index.html', wait_until='load')
        await pg.evaluate('window.filmReady')
        t0=time.time()
        for f in range(a, b):
            path=f'{OUT}/f_{f:04d}.jpg'
            if os.path.exists(path): continue
            await pg.evaluate(f'window.renderFrame({f})')
            await pg.screenshot(path=path+'.tmp', type='jpeg', quality=93)
            os.replace(path+'.tmp', path)
            if f % 50 == 0: print(f, round(time.time()-t0), errs[:2], flush=True)
        print('done', a, b, round(time.time()-t0), errs[:3], flush=True)
        await br.close()
asyncio.run(main())
