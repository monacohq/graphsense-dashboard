const path = require('path')
const glob = require('glob-all')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CleanWebpackPlugin = require('clean-webpack-plugin')
const noop = require('noop-webpack-plugin')
const webpack = require('webpack')
const StaticSiteGeneratorPlugin = require('static-site-generator-webpack-plugin')
const hb = require('handlebars')
const fs = require('fs')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const PurgecssPlugin = require('purgecss-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')

const VERSION = '0.4.1'
const DEV_REST_ENDPOINT = 'http://localhost:9000'
const SUPPORTED_KEYSPACES = ['btc', 'bch', 'ltc', 'zec']

// to be injected in static and dynamic pages
const STATICPAGE_CLASSES = 'flex flex-col min-h-full'

// compose pre-rendered landing page
let template = hb.compile(fs.readFileSync(path.join(__dirname, 'src', 'pages', 'static', 'page.hbs'), 'utf-8'))
let boldheader = hb.compile(fs.readFileSync(path.join(__dirname, 'src', 'pages', 'static', 'boldheader.html'), 'utf-8'))
let landingpage = fs.readFileSync(path.join(__dirname, 'src', 'pages', 'statistics.html'), 'utf-8')
let footer = hb.compile(fs.readFileSync(path.join(__dirname, 'src', 'pages', 'static', 'footer.html'), 'utf-8'))
boldheader = boldheader({action: ''})
footer = footer({version: VERSION})

const src = path.join(__dirname, 'src')

module.exports = env => {
  let IS_DEV = !env || !env.production

  let JWT_TOKEN = env && env.token

  let output = {
    filename: '[name].js?[hash]',
    path: path.resolve(__dirname, 'dist')
  }

  if (!IS_DEV) {
    output['libraryTarget'] = 'umd' // needed for static-site-generator-plugin
    output['globalObject'] = 'this' // fix issue with webpack 4, see https://github.com/markdalgleish/static-site-generator-webpack-plugin/issues/130
  } else {
    output['globalObject'] = 'self'
  }

  console.log(IS_DEV ? 'Development mode' : 'Production mode')
  return {
    mode: IS_DEV ? 'development' : 'production',
    entry: {
      static: './src/static.js',
      main: './src/index.js',
      sw: './src/sw.js'
    },
    devtool: IS_DEV ? 'inline-source-map' : false,
    devServer: IS_DEV ? {
      contentBase: false,
      hot: true
    } : {},
    plugins: [
      new CleanWebpackPlugin(['dist']),
      new HtmlWebpackPlugin({
        title: 'GraphSense App',
        excludeChunks: ['static'],
        template: './src/pages/static/page.hbs',
        header: boldheader,
        page: landingpage,
        footer: footer,
        staticpage_classes: STATICPAGE_CLASSES
      }),
      new CopyWebpackPlugin([{
        from: './src/pages/static/logo-without-icon.svg'
      }]),
      IS_DEV ? new webpack.HotModuleReplacementPlugin() : noop(),
      new webpack.DefinePlugin({
        IS_DEV: IS_DEV,
        REST_ENDPOINT: !IS_DEV ? '\'{{REST_ENDPOINT}}\'' : '\'' + DEV_REST_ENDPOINT + '\'',
        VERSION: '\'' + VERSION + '\'',
        STATICPAGE_CLASSES: '\'' + STATICPAGE_CLASSES + '\'',
        JWT_TOKEN: !IS_DEV ? '\'{{JWT_TOKEN}}\'' : '\'' + JWT_TOKEN + '\'',
        SUPPORTED_KEYSPACES: '\'' + JSON.stringify(SUPPORTED_KEYSPACES).replace(/'/g, '"') + '\''
      }),
      new webpack.ProvidePlugin({
        $: 'jquery',
        jQuery: 'jquery'
      }),
      !IS_DEV ? new StaticSiteGeneratorPlugin({
        paths: [
          '/terms.html',
          '/privacy.html',
          '/about.html',
          '/officialpage.html'
        ],
        entry: 'static', // refers to entry.static
        locals: {
          template: template,
          footer: footer,
          staticpage_classes: STATICPAGE_CLASSES
        }
      }) : noop(),
      new MiniCssExtractPlugin({
        filename: '[name].css?[hash]',
        chunkFilename: '[id].css'
      }),
      !IS_DEV ? new PurgecssPlugin({
        paths: glob.sync([
          path.join(src, '**', '*.js'),
          path.join(src, '**', '*.html'),
          path.join(src, '**', '*.hbs')
        ], {nodir: true}),
        extractors: [
          {
            extractor: class {
              static extract (content) {
                return content.match(/[A-Za-z0-9-_:\/]+/g) || []
              }
            },
            extensions: ['html', 'js', 'hbs']
          }
        ],
        whitelistPatterns: [
          /d3-context-menu.+/,
          /svg.+/
        ],
        whitelistPatternsChildren: [
          /d3-context-menu.+/,
          /DTS/,
          /dataTables/,
          /dataTable/,
          /fa-.+/,
          /min-h-full/,
          /svg.+/
        ]
      }) : noop()
    ],
    output: output,
    module: {
      rules: [
        {
          test: /\[^(static)].m?js$/,
          exclude: /(node_modules|bower_components)/,
          use: [
            {
              loader: 'babel-loader',
              options: {
                presets: [
                  [
                    '@babel/preset-env',
                    {
                      targets: {
                        edge: '17',
                        firefox: '60',
                        chrome: '67',
                        safari: '11.1'
                      },
                      useBuiltIns: 'usage'
                    }
                  ]
                ]
              }
            }
          ]
        },
        {
          test: /\.css$/,
          use: [
            MiniCssExtractPlugin.loader,
            {loader: 'css-loader', options: { importLoaders: 1 } },
            'postcss-loader'
          ]
        },
        {
          test: /\.html$/,
          use: [ {
            loader: 'html-loader',
            options: {
              minimize: true,
              removeComments: false,
              collapseWhitespace: false
            }
          }]
        },
        // the file-loader emits files.
        {
          test: /\.(woff(2)?|ttf|eot|svg|jpe?g|png|gif)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
          loader: 'file-loader'
        },
        {
          test: /\.hbs$/,
          loader: 'handlebars-loader'
        }
      ]
    },
    resolve: {
      mainFields: ['browser', 'module', 'main']
    }
  }
}
