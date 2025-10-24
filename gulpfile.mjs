// -------------------- Imports --------------------
import gulp from 'gulp';
import plumber from 'gulp-plumber';
import gulpIf from 'gulp-if';

import * as dartSass from 'sass';
import gulpSass from 'gulp-sass';

import postcss from 'gulp-postcss';
import postUrl from 'postcss-url';
import autoprefixer from 'autoprefixer';
import csso from 'postcss-csso';

import htmlmin from 'gulp-htmlmin';
import replace from 'gulp-replace';
import rename from 'gulp-rename';
import terser from 'gulp-terser';

import svgo from 'gulp-svgmin';
// Универсальный импорт stacksvg (работает с любым экспортом)
import * as stacksvgNS from 'gulp-stacksvg';
const stacksvg = stacksvgNS.default ?? stacksvgNS.stacksvg ?? stacksvgNS;

import sharp from 'sharp';
import through2 from 'through2';
import Vinyl from 'vinyl';
import * as cheerio from 'cheerio';
import newer from 'gulp-newer';

import { deleteAsync } from 'del';
import browser from 'browser-sync';

import bemlinter from 'gulp-html-bemlinter';
import { htmlValidator } from 'gulp-w3c-html-validator';

// -------------------- Runtime guards (dev only) --------------------
if (process.env.NODE_ENV !== 'production') {
    if (process.listenerCount('uncaughtException') === 0) {
        process.on('uncaughtException', (err) => {
            console.error('[uncaughtException]', err?.stack || err);
        });
    }
    if (process.listenerCount('unhandledRejection') === 0) {
        process.on('unhandledRejection', (reason) => {
            console.error('[unhandledRejection]', reason);
        });
    }
}

// -------------------- Flags & constants --------------------
const compileSass = gulpSass(dartSass);
const isDevelopment = process.env.NODE_ENV !== 'production';

const BS_PORT = Number(process.env.BS_PORT);
const FAST_DEV = process.env.FAST_DEV === '1';

// -------------------- Helpers --------------------
function onError(taskName) {
    return function (err) {
        console.error(`\x1b[31m[${taskName}]\x1b[0m ${err?.message || err}`);
        if (err?.stack) console.error(err.stack);
        this.emit('end');
    };
}

// -------------------- BrowserSync --------------------
const server = browser.create();

/* ---------- HTML ---------- */
export function processMarkup() {
    return gulp.src('source/*.html')
        .pipe(plumber({ errorHandler: onError('processMarkup') }))
        .pipe(gulpIf(
            isDevelopment,
            replace(/<link[^>]*\brel=["']preload["'][^>]*\bas=["']image["'][^>]*>/gi, '')
            ))
        .pipe(gulpIf(!isDevelopment, htmlmin({
            collapseWhitespace: true,
            conservativeCollapse: true
        })))
            .pipe(gulpIf(
                !isDevelopment,
                replace(/(<link[^>]*\brel=["']preload["'][^>]*\bas=["']style["'][^>]*\bhref=["'][^"']*?)css\/style\.css(\?v=\d+)?/gi, '$1css/style.min.css$2')
                ))
        .pipe(gulpIf(
        !isDevelopment,
        replace(/(["'])(?:\.?\/)?\/?css\/style\.css((?:\?v=\d+)?)\1/gi, '$1css/style.min.css$2$1')
        ))
        .pipe(gulp.dest('build'))
        .pipe(server.stream());
}

export function lintBem() {
    return gulp.src('source/*.html').pipe(bemlinter());
}

export function validateMarkup() {
    return gulp.src('source/*.html')
        .pipe(htmlValidator.analyzer())
        .pipe(htmlValidator.reporter({ throwErrors: true }));
}

/* ---------- HTML: автогенерация <picture> ---------- */
export function injectPicture() {
    return gulp.src('build/*.html')
        .pipe(plumber({ errorHandler: onError('injectPicture') }))
        .pipe(through2.obj(function (file, _, cb) {
            try {
                const html = file.contents.toString();
                const $ = cheerio.load(html, { decodeEntities: false });

                $('img[src]').each((_, el) => {
                    const $img = $(el);
                    if ($img.parents('picture').length) return;
                    if ($img.attr('srcset')) return;

                    const src = $img.attr('src');
                    if (!src || /^data:/.test(src) || /^https?:\/\//.test(src)) return;
                    const m = src.match(/\.(png|jpe?g)$/i);
                    if (!m) return;

                    const avif = src.replace(/\.(png|jpe?g)$/i, '.avif');
                    const webp = src.replace(/\.(png|jpe?g)$/i, '.webp');

                    const attrs = {
                        alt: $img.attr('alt') ?? '',
                        class: $img.attr('class'),
                        width: $img.attr('width'),
                        height: $img.attr('height'),
                        loading: $img.attr('loading') ?? 'lazy',
                        decoding: $img.attr('decoding') ?? 'async'
                    };

                    const $picture = $('<picture></picture>');
                    $picture.append(`<source srcset="${avif}" type="image/avif">`);
                    $picture.append(`<source srcset="${webp}" type="image/webp">`);
                    const $fallback = $('<img/>').attr('src', src).attr(attrs);
                    $picture.append($fallback);
                    $img.replaceWith($picture);
                });

                file.contents = Buffer.from($.html());
                cb(null, file);
            } catch (e) { cb(e); }
        }))
        .pipe(gulp.dest('build'));
}

/* ---------- STYLES ---------- */
export function processStyles() {
    const plugins = [postUrl({ url: 'rebase' }), autoprefixer()];
    if (!isDevelopment) plugins.push(csso());

    return gulp.src('source/sass/style.scss', { sourcemaps: isDevelopment })
        .pipe(plumber({ errorHandler: onError('processStyles') }))
        .pipe(compileSass({ outputStyle: isDevelopment ? 'expanded' : 'compressed' }).on('error', compileSass.logError))
        .pipe(postcss(plugins))
        .pipe(gulpIf(!isDevelopment, rename({ suffix: '.min' })))
        .pipe(gulp.dest('build/css', { sourcemaps: isDevelopment }))
        .pipe(server.stream());
}

/* ---------- SCRIPTS ---------- */
export function processScripts() {
    return gulp.src('source/js/**/*.js', { sourcemaps: isDevelopment })
        .pipe(plumber({ errorHandler: onError('processScripts') }))
        .pipe(gulpIf(!isDevelopment, terser()))
        .pipe(gulp.dest('build/js', { sourcemaps: isDevelopment }))
        .pipe(server.stream());
}

/* ---------- IMAGES ---------- */
export function optimizeImages() {
    return gulp.src('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}')
        .pipe(plumber({ errorHandler: onError('optimizeImages') }))
        .pipe(newer('build/img'))
        .pipe(gulpIf(!isDevelopment, through2.obj(async function (file, _, cb) {
            try {
                const isPng = /\.png$/i.test(file.path);
                const buf = await sharp(file.contents)
                    .toFormat(isPng ? 'png' : 'jpeg', isPng
                        ? { compressionLevel: 9 }
                        : { quality: 80, mozjpeg: true })
                    .toBuffer();
                file.contents = buf;
                cb(null, file);
            } catch (e) { cb(e); }
        })))
        .pipe(gulp.dest('build/img'));
}

export function createWebp() {
    return gulp.src('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}')
        .pipe(plumber({ errorHandler: onError('createWebp') }))
        .pipe(newer({ dest: 'build/img', ext: '.webp' }))
        .pipe(through2.obj(async function (file, _, cb) {
            try {
                const buf = await sharp(file.contents).webp({ quality: 80 }).toBuffer();
                const out = new Vinyl({
                    cwd: file.cwd,
                    base: file.base,
                    path: file.path.replace(/\.(png|jpe?g)$/i, '.webp'),
                    contents: buf,
                });
                cb(null, out);
            } catch (e) { cb(e); }
        }))
        .pipe(gulp.dest('build/img'));
}

export function createAvif() {
    return gulp.src('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}')
        .pipe(plumber({ errorHandler: onError('createAvif') }))
        .pipe(newer({ dest: 'build/img', ext: '.avif' }))
        .pipe(through2.obj(async function (file, _, cb) {
            try {
                const buf = await sharp(file.contents).avif({
                    quality: 50,
                    effort: 5,
                    chromaSubsampling: '4:4:4'
                }).toBuffer();
                const out = new Vinyl({
                    cwd: file.cwd,
                    base: file.base,
                    path: file.path.replace(/\.(png|jpe?g)$/i, '.avif'),
                    contents: buf,
                });
                cb(null, out);
            } catch (e) { cb(e); }
        }))
        .pipe(gulp.dest('build/img'));
}

/* ---------- SVG ---------- */
export function optimizeVector() {
    return gulp.src(['source/img/**/*.svg', '!source/img/icons/**/*.svg'])
        .pipe(plumber({ errorHandler: onError('optimizeVector') }))
        .pipe(svgo())
        .pipe(gulp.dest('build/img'));
}

export function createStack() {
    return gulp.src('source/img/icons/**/*.svg')
        .pipe(plumber({ errorHandler: onError('createStack') }))
        .pipe(svgo())
        .pipe(stacksvg())
        .pipe(gulp.dest('build/img/icons'));
}

/* ---------- FONTS ---------- */
export const copyFonts = () => {
    return gulp.src('source/fonts/**/*.{woff,woff2}', { allowEmpty: true })
        .pipe(plumber({ errorHandler: onError('copyFonts') }))
        .pipe(gulp.dest('build/fonts'));
};

/* ---------- STATIC / ASSETS ---------- */
export function copyAssets() {
    return gulp.src(['source/*.webmanifest', 'source/*.ico'], { base: 'source' })
        .pipe(plumber({ errorHandler: onError('copyAssets') }))
        .pipe(newer('build'))
        .pipe(gulp.dest('build'));
}

/* ---------- SERVER ---------- */
export function startServer(done) {
    const portEnv = Number(process.env.BS_PORT);
    const PORT = Number.isFinite(portEnv) && portEnv > 0 ? portEnv : 3000;

    // Никаких обращений к server.options в колбэке — это и ломалось
    server.init({
        server: { baseDir: 'build' },
        cors: true,
        notify: false,
        ui: false,
        host: 'localhost',
        open: true,          // откроет вкладку сам
        online: false,
        ghostMode: false,
        reloadDebounce: 300,
        reloadOnRestart: true,
        port: PORT,
        logFileChanges: true,
    });

    // На всякий случай просто напечатаем предполагаемый URL
    console.log(`[BrowserSync] Try: http://localhost:${PORT}`);

    done();
}

function reloadServer(done) {
    server.reload();
    done();
}

/* ---------- WATCHERS ---------- */
function watchFiles(done) {
    const w1 = gulp.watch('source/sass/**/*.scss', gulp.series(processStyles));
    gulp.watch('source/js/**/*.js', gulp.series(processScripts));
    gulp.watch('source/*.html', gulp.series(processMarkup, injectPicture, reloadServer));
    gulp.watch('source/manifest.json', gulp.series(copyAssets, reloadServer));
    gulp.watch('source/*.webmanifest', gulp.series(copyAssets, reloadServer));
    gulp.watch('source/img/**/*.svg', gulp.series(optimizeVector, createStack, reloadServer));
    if (FAST_DEV) {
        gulp.watch('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}', gulp.series(optimizeImages, reloadServer));
    } else {
        gulp.watch('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}', gulp.series(optimizeImages, createWebp, createAvif, reloadServer));
    }
    gulp.watch('source/fonts/**/*.{woff,woff2}', gulp.series(copyFonts, reloadServer));
    done();
    return w1;
}

/* ---------- CLEAN / BUILD CHAINS ---------- */
export function deleteBuild() {
    return deleteAsync(['build/**', '!build']);
}
export const clean = deleteBuild;

function compileProject(done) {
    const parallelTasks = gulp.parallel(
        processMarkup,
        processStyles,
        processScripts,
        optimizeVector,
        createStack,
        copyAssets,
        copyFonts,
        optimizeImages,
        createWebp,
        createAvif
    );
    gulp.series(parallelTasks, injectPicture)(done);
}

/* ---------- PUBLIC TASKS ---------- */
export function buildProd(done) {
    isDevelopment = false;
    gulp.series(clean, compileProject)(done);
}

export function runDev(done) {
    isDevelopment = true;
    gulp.series(clean, compileProject, gulp.parallel(startServer, watchFiles))(done);
}
