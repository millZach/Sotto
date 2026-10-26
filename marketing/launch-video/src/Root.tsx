import React from 'react'
import { Composition } from 'remotion'
import { Film } from './Film'
import { FILM_SECONDS } from './edit'

export const FPS = 60

export const Root: React.FC = () => (
  <Composition id="Launch" component={Film} durationInFrames={Math.round(FILM_SECONDS * FPS)} fps={FPS} width={1080} height={1920} />
)
