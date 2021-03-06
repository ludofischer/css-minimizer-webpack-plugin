import os from 'os';
import crypto from 'crypto';

import { SourceMapConsumer } from 'source-map';
import RequestShortener from 'webpack/lib/RequestShortener';
import webpack, {
  ModuleFilenameHelpers,
  SourceMapDevToolPlugin,
  version as webpackVersion,
} from 'webpack';
import { validate } from 'schema-utils';
import serialize from 'serialize-javascript';
import CssMinimizerPackageJson from 'cssnano/package.json';
import pLimit from 'p-limit';
import Worker from 'jest-worker';

import schema from './options.json';

import { minify as minifyFn } from './minify';

const warningRegex = /\s.+:+([0-9]+):+([0-9]+)/;

// webpack 5 exposes the sources property to ensure the right version of webpack-sources is used
const { SourceMapSource, RawSource } =
  // eslint-disable-next-line global-require
  webpack.sources || require('webpack-sources');

class CssMinimizerPlugin {
  constructor(options = {}) {
    validate(schema, options, {
      name: 'Css Minimizer Plugin',
      baseDataPath: 'options',
    });

    const {
      minify,
      minimizerOptions = {
        preset: 'default',
      },
      test = /\.css(\?.*)?$/i,
      warningsFilter = () => true,
      sourceMap,
      cache = true,
      cacheKeys = (defaultCacheKeys) => defaultCacheKeys,
      parallel = true,
      include,
      exclude,
    } = options;

    this.options = {
      test,
      warningsFilter,
      sourceMap,
      cache,
      cacheKeys,
      parallel,
      include,
      exclude,
      minify,
      minimizerOptions,
    };
  }

  static isSourceMap(input) {
    // All required options for `new SourceMapConsumer(...options)`
    // https://github.com/mozilla/source-map#new-sourcemapconsumerrawsourcemap
    return Boolean(
      input &&
        input.version &&
        input.sources &&
        Array.isArray(input.sources) &&
        typeof input.mappings === 'string'
    );
  }

  static buildError(error, file, sourceMap, requestShortener) {
    if (error.line) {
      const original =
        sourceMap &&
        sourceMap.originalPositionFor({
          line: error.line,
          column: error.column,
        });

      if (original && original.source && requestShortener) {
        return new Error(
          `${file} from Css Minimizer Webpack Plugin\n${
            error.message
          } [${requestShortener.shorten(original.source)}:${original.line},${
            original.column
          }][${file}:${error.line},${error.column}]${
            error.stack
              ? `\n${error.stack.split('\n').slice(1).join('\n')}`
              : ''
          }`
        );
      }

      return new Error(
        `${file} from Css Minimizer \n${error.message} [${file}:${error.line},${
          error.column
        }]${
          error.stack ? `\n${error.stack.split('\n').slice(1).join('\n')}` : ''
        }`
      );
    }

    if (error.stack) {
      return new Error(`${file} from Css Minimizer\n${error.stack}`);
    }

    return new Error(`${file} from Css Minimizer\n${error.message}`);
  }

  static buildWarning(
    warning,
    file,
    sourceMap,
    requestShortener,
    warningsFilter
  ) {
    let warningMessage = warning;
    let locationMessage = '';
    let source;

    if (sourceMap) {
      const match = warningRegex.exec(warning);

      if (match) {
        const line = +match[1];
        const column = +match[2];
        const original = sourceMap.originalPositionFor({
          line,
          column,
        });

        if (
          original &&
          original.source &&
          original.source !== file &&
          requestShortener
        ) {
          ({ source } = original);

          warningMessage = `${warningMessage.replace(warningRegex, '')}`;
          locationMessage = `${requestShortener.shorten(original.source)}:${
            original.line
          }:${original.column}`;
        }
      }
    }

    if (warningsFilter && !warningsFilter(warning, file, source)) {
      return null;
    }

    return `Css Minimizer Plugin: ${warningMessage} ${locationMessage}`;
  }

  static getAvailableNumberOfCores(parallel) {
    // In some cases cpus() returns undefined
    // https://github.com/nodejs/node/issues/19022
    const cpus = os.cpus() || { length: 1 };

    return parallel === true
      ? cpus.length - 1
      : Math.min(Number(parallel) || 0, cpus.length - 1);
  }

  // eslint-disable-next-line consistent-return
  static getAsset(compilation, name) {
    // New API
    if (compilation.getAsset) {
      return compilation.getAsset(name);
    }

    if (compilation.assets[name]) {
      return { name, source: compilation.assets[name], info: {} };
    }
  }

  static updateAsset(compilation, name, newSource, assetInfo) {
    // New API
    if (compilation.updateAsset) {
      compilation.updateAsset(name, newSource, assetInfo);
    }

    // eslint-disable-next-line no-param-reassign
    compilation.assets[name] = newSource;
  }

  async optimize(compiler, compilation, assets, CacheEngine, weakCache) {
    const assetNames = Object.keys(
      typeof assets === 'undefined' ? compilation.assets : assets
    ).filter((assetName) => {
      if (
        !ModuleFilenameHelpers.matchObject.bind(
          // eslint-disable-next-line no-undefined
          undefined,
          this.options
        )(assetName)
      ) {
        return false;
      }

      const { info } = CssMinimizerPlugin.getAsset(compilation, assetName);

      if (info.minimized) {
        return false;
      }

      return true;
    });

    if (assetNames.length === 0) {
      return Promise.resolve();
    }

    const availableNumberOfCores = CssMinimizerPlugin.getAvailableNumberOfCores(
      this.options.parallel
    );

    let concurrency = Infinity;
    let worker;

    if (availableNumberOfCores > 0) {
      // Do not create unnecessary workers when the number of files is less than the available cores, it saves memory
      const numWorkers = Math.min(assetNames.length, availableNumberOfCores);

      concurrency = numWorkers;

      worker = new Worker(require.resolve('./minify'), { numWorkers });

      // https://github.com/facebook/jest/issues/8872#issuecomment-524822081
      const workerStdout = worker.getStdout();

      if (workerStdout) {
        workerStdout.on('data', (chunk) => process.stdout.write(chunk));
      }

      const workerStderr = worker.getStderr();

      if (workerStderr) {
        workerStderr.on('data', (chunk) => process.stderr.write(chunk));
      }
    }

    const limit = pLimit(concurrency);
    const cache = new CacheEngine(
      compilation,
      { cache: this.options.cache },
      weakCache
    );
    const scheduledTasks = [];

    for (const name of assetNames) {
      scheduledTasks.push(
        limit(async () => {
          const { source: inputSource, info } = CssMinimizerPlugin.getAsset(
            compilation,
            name
          );

          // Skip double minimize assets from child compilation
          if (info.minimized) {
            return;
          }

          let input;
          let inputSourceMap;

          // TODO refactor after drop webpack@4, webpack@5 always has `sourceAndMap` on sources
          if (this.options.sourceMap && inputSource.sourceAndMap) {
            const { source, map } = inputSource.sourceAndMap();

            input = source;

            if (map) {
              if (CssMinimizerPlugin.isSourceMap(map)) {
                inputSourceMap = map;
              } else {
                inputSourceMap = map;

                compilation.warnings.push(
                  new Error(`${name} contains invalid source map`)
                );
              }
            }
          } else {
            input = inputSource.source();
            inputSourceMap = null;
          }

          if (Buffer.isBuffer(input)) {
            input = input.toString();
          }

          const cacheData = { name, inputSource };

          if (CssMinimizerPlugin.isWebpack4()) {
            if (this.options.cache) {
              cacheData.input = input;
              cacheData.inputSourceMap = inputSourceMap;
              cacheData.cacheKeys = this.options.cacheKeys(
                {
                  // eslint-disable-next-line global-require
                  'css-minimizer-webpack-plugin': require('../package.json')
                    .version,
                  cssMinimizer: CssMinimizerPackageJson.version,
                  'css-minimizer-webpack-plugin-options': this.options,
                  name,
                  contentHash: crypto
                    .createHash('md4')
                    .update(input)
                    .digest('hex'),
                },
                name
              );
            }
          }

          let output = await cache.get(cacheData, {
            RawSource,
            SourceMapSource,
          });

          if (!output) {
            try {
              const minimizerOptions = {
                name,
                input,
                inputSourceMap,
                map: this.options.sourceMap,
                minimizerOptions: this.options.minimizerOptions,
                minify: this.options.minify,
              };

              output = await (worker
                ? worker.transform(serialize(minimizerOptions))
                : minifyFn(minimizerOptions));
            } catch (error) {
              compilation.errors.push(
                CssMinimizerPlugin.buildError(
                  error,
                  name,
                  inputSourceMap &&
                    CssMinimizerPlugin.isSourceMap(inputSourceMap)
                    ? new SourceMapConsumer(inputSourceMap)
                    : null,
                  new RequestShortener(compiler.context)
                )
              );

              return;
            }

            if (output.map) {
              output.source = new SourceMapSource(
                output.code,
                name,
                output.map,
                input,
                inputSourceMap,
                true
              );
            } else {
              output.source = new RawSource(output.code);
            }

            await cache.store({ ...output, ...cacheData });
          }

          if (output.warnings && output.warnings.length > 0) {
            output.warnings.forEach((warning) => {
              const builtWarning = CssMinimizerPlugin.buildWarning(
                warning,
                name,
                inputSourceMap && CssMinimizerPlugin.isSourceMap(inputSourceMap)
                  ? new SourceMapConsumer(inputSourceMap)
                  : null,
                new RequestShortener(compiler.context),
                this.options.warningsFilter
              );

              if (builtWarning) {
                compilation.warnings.push(builtWarning);
              }
            });
          }

          // TODO `...` required only for webpack@4
          const newInfo = { ...info, minimized: true };
          const { source } = output;

          CssMinimizerPlugin.updateAsset(compilation, name, source, newInfo);
        })
      );
    }

    const result = await Promise.all(scheduledTasks);

    if (worker) {
      await worker.end();
    }

    return result;
  }

  static isWebpack4() {
    return webpackVersion[0] === '4';
  }

  apply(compiler) {
    const pluginName = this.constructor.name;
    const { devtool, plugins } = compiler.options;

    this.options.sourceMap =
      typeof this.options.sourceMap === 'undefined'
        ? (devtool &&
            !devtool.includes('eval') &&
            !devtool.includes('cheap') &&
            (devtool.includes('source-map') ||
              // Todo remove when `webpack@4` support will be dropped
              devtool.includes('sourcemap'))) ||
          (plugins &&
            plugins.some(
              (plugin) =>
                plugin instanceof SourceMapDevToolPlugin &&
                plugin.options &&
                plugin.options.columns
            ))
        : this.options.sourceMap;

    const weakCache = new WeakMap();

    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      if (this.options.sourceMap) {
        compilation.hooks.buildModule.tap(pluginName, (moduleArg) => {
          // to get detailed location info about errors
          // eslint-disable-next-line no-param-reassign
          moduleArg.useSourceMap = true;
        });
      }

      if (CssMinimizerPlugin.isWebpack4()) {
        // eslint-disable-next-line global-require
        const CacheEngine = require('./Webpack4Cache').default;

        compilation.hooks.optimizeChunkAssets.tapPromise(pluginName, () =>
          this.optimize(
            compiler,
            compilation,
            // eslint-disable-next-line no-undefined
            undefined,
            CacheEngine,
            weakCache
          )
        );
      } else {
        if (this.options.sourceMap) {
          compilation.hooks.buildModule.tap(pluginName, (moduleArg) => {
            // to get detailed location info about errors
            // eslint-disable-next-line no-param-reassign
            moduleArg.useSourceMap = true;
          });
        }

        // eslint-disable-next-line global-require
        const CacheEngine = require('./Webpack5Cache').default;

        // eslint-disable-next-line global-require
        const Compilation = require('webpack/lib/Compilation');

        compilation.hooks.processAssets.tapPromise(
          {
            name: pluginName,
            stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
            additionalAssets: true,
          },
          (assets) => this.optimize(compiler, compilation, assets, CacheEngine)
        );

        compilation.hooks.statsPrinter.tap(pluginName, (stats) => {
          stats.hooks.print
            .for('asset.info.minimized')
            .tap(
              'css-minimizer-webpack-plugin',
              (minimized, { green, formatFlag }) =>
                // eslint-disable-next-line no-undefined
                minimized ? green(formatFlag('minimized')) : undefined
            );
        });
      }
    });
  }
}

export default CssMinimizerPlugin;
