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
import { stacksvg } from 'gulp-stacksvg';

import sharp from 'sharp';
import through2 from 'through2';
import Vinyl from 'vinyl';
import * as cheerio from 'cheerio';
import newer from 'gulp-newer';

import { deleteAsync } from 'del';
import browser from 'browser-sync';

import bemlinter from 'gulp-html-bemlinter';
import { htmlValidator } from 'gulp-w3c-html-validator';

const compileSass = gulpSass(dartSass);
let isDevelopment = true;

// BrowserSync instance
const server = browser.create();

/* ---------- HTML ---------- */
export function processMarkup() {
    return gulp.src('source/*.html')
        .pipe(gulpIf(!isDevelopment, htmlmin({
            collapseWhitespace: true,
            conservativeCollapse: true
        })))
        // ↓↓↓ добавь этот блок
        .pipe(gulpIf(
            !isDevelopment,
            replace(/(["'])\.?\/?css\/style\.css(\?v=\d+)?\1/g, '"./css/style.min.css?v=1"')
        ))
        .pipe(gulp.dest('build'));
}

export function lintBem() {
    return gulp.src('source/*.html').pipe(bemlinter());
}

export function validateMarkup() {
    return gulp.src('source/*.html')
        .pipe(htmlValidator.analyzer())
        .pipe(htmlValidator.reporter({ throwErrors: true }));
}

// ---------- HTML: автогенерация <picture> с AVIF + WebP ----------
export function injectPicture() {
    // Работает по уже собранным HTML в build/
    return gulp.src('build/*.html')
        .pipe(through2.obj(function (file, _, cb) {
            try {
                const html = file.contents.toString();
                const $ = cheerio.load(html, { decodeEntities: false });

                $('img[src]').each((_, el) => {
                    const $img = $(el);

                    // не трогаем, если уже внутри <picture> или если есть srcset (чтобы не сломать авторскую адаптацию)
                    if ($img.parents('picture').length) return;
                    if ($img.attr('srcset')) return;

                    const src = $img.attr('src');
                    // пропускаем data: и абсолютные внешние URL
                    if (!src || /^data:/.test(src) || /^https?:\/\//.test(src)) return;

                    // работаем только с png/jpg/jpeg
                    const m = src.match(/\.(png|jpe?g)$/i);
                    if (!m) return;

                    const avif = src.replace(/\.(png|jpe?g)$/i, '.avif');
                    const webp = src.replace(/\.(png|jpe?g)$/i, '.webp');

                    // переносим основные атрибуты на <img>
                    const attrs = {
                        alt: $img.attr('alt') ?? '',
                        class: $img.attr('class'),
                        width: $img.attr('width'),
                        height: $img.attr('height'),
                        loading: $img.attr('loading') ?? 'lazy',
                        decoding: $img.attr('decoding') ?? 'async'
                    };

                    const $picture = $('<picture></picture>');
                    // AVIF приоритетнее, затем WebP, затем JPEG/PNG
                    $picture.append(`<source srcset="${avif}" type="image/avif">`);
                    $picture.append(`<source srcset="${webp}" type="image/webp">`);

                    const $fallback = $('<img/>')
                        .attr('src', src)
                        .attr(attrs);

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
    const plugins = [
        postUrl({ url: 'rebase' }),
        autoprefixer(),
    ];
    if (!isDevelopment) plugins.push(csso());

    return gulp.src('source/sass/style.scss', { sourcemaps: isDevelopment })
        .pipe(plumber())
        .pipe(compileSass().on('error', compileSass.logError))  // <- меняем тут
        .pipe(postcss(plugins))
        .pipe(gulpIf(!isDevelopment, rename({ suffix: '.min' }))) // получим style.min.css в prod
        .pipe(gulp.dest('build/css', { sourcemaps: isDevelopment }))
        .pipe(server.stream());
}

/* ---------- SCRIPTS ---------- */
export function processScripts() {
    return gulp.src('source/js/**/*.js', { sourcemaps: isDevelopment })
        .pipe(gulpIf(!isDevelopment, terser()))
        .pipe(gulp.dest('build/js', { sourcemaps: isDevelopment }))
        .pipe(server.stream());
}

/* ---------- IMAGES (PNG/JPG/JPEG + WebP + AVIF через sharp) ---------- */
export function optimizeImages() {
    return gulp.src('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}')
        .pipe(newer('build/img')) // ⬅️ Проверка: если файл уже есть — пропускаем
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
        .pipe(newer({ dest: 'build/img', ext: '.webp' })) // ✅ сравнение с .webp
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
        .pipe(newer({ dest: 'build/img', ext: '.avif' })) // ✅ сравнение с .avif
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
        .pipe(svgo())
        .pipe(gulp.dest('build/img'));
}

export function createStack() {
    return gulp.src('source/img/icons/**/*.svg')
        .pipe(svgo())
        .pipe(stacksvg())
        .pipe(gulp.dest('build/img/icons'));
}

/* ---------- КОПИРОВАНИЕ ШРИФТОВ ---------- */
export const copyFonts = () => {
    return gulp.src('source/fonts/**/*.{woff,woff2}', { allowEmpty: true })
        .pipe(gulp.dest('build/fonts'));
};

/* ---------- STATIC / ASSETS ---------- */
export function copyAssets() {
    return gulp.src([
        'source/manifest.json',
        'source/*.webmanifest',
        'source/*.ico'
    ], { base: 'source' })
        .pipe(newer('build'))
        .pipe(gulp.dest('build'));
}

/* ---------- SERVER ---------- */
export function startServer(done) {
    server.init({
        server: { baseDir: 'build' },
        cors: true,
        notify: false,
        ui: false,
    });
    done();
}

function reloadServer(done) {
    server.reload();
    done();
}

/* ---------- WATCHERS ---------- */
function watchFiles() {
    gulp.watch('source/sass/**/*.scss', gulp.series(processStyles));
    gulp.watch('source/js/**/*.js', gulp.series(processScripts));
    gulp.watch('source/*.html', gulp.series(processMarkup, injectPicture, reloadServer));

    gulp.watch('source/manifest.json', gulp.series(copyAssets, reloadServer));
    gulp.watch('source/*.webmanifest', gulp.series(copyAssets, reloadServer));

    gulp.watch('source/img/**/*.{png,jpg,jpeg,PNG,JPG,JPEG}', gulp.series(optimizeImages, createWebp, createAvif, reloadServer));
    gulp.watch('source/img/**/*.svg', gulp.series(optimizeVector, createStack, reloadServer));
    gulp.watch('source/fonts/**/*.{woff,woff2}', gulp.series(copyFonts, reloadServer));
}

/* ---------- CLEAN / BUILD CHAINS ---------- */
// Базовая очистка (оставляем имя для совместимости)
export function deleteBuild() {
    return deleteAsync(['build/**', '!build']);
}
// Удобный алиас: npx gulp clean
export const clean = deleteBuild;

function compileProject(done) {
    // Всё, что можно делать параллельно
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

    // После этого — HTML-дополнение с <picture>
    gulp.series(parallelTasks, injectPicture)(done);
}

/* ---------- PUBLIC TASKS ---------- */
export function buildProd(done) {
    isDevelopment = false;
    gulp.series(clean, compileProject)(done);
}

export function runDev(done) {
    isDevelopment = true;
    gulp.series(clean, compileProject, startServer, watchFiles)(done);
}
