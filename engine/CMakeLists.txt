cmake_minimum_required(VERSION 3.22)
project(YSSEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.15
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

# ASIO: Steinberg SDK 는 재배포 불가라 리포에 없음. 사용자가 SDK 받아 경로 지정.
#   cmake -DYSS_ENABLE_ASIO=ON -DYSS_ASIO_SDK_DIR=C:/sdk/asiosdk/common ...
option(YSS_ENABLE_ASIO "Enable ASIO backend (needs Steinberg ASIO SDK)" OFF)
set(YSS_ASIO_SDK_DIR "" CACHE PATH "Path to ASIO SDK dir containing asio.h")

juce_add_console_app(yss-engine PRODUCT_NAME "yss-engine")

target_sources(yss-engine PRIVATE src/Main.cpp)

target_compile_definitions(yss-engine PRIVATE
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=0
  JUCE_STRICT_REFCOUNTEDPOINTER=1)

if(YSS_ENABLE_ASIO)
  message(STATUS "ASIO enabled, SDK: ${YSS_ASIO_SDK_DIR}")
  target_compile_definitions(yss-engine PRIVATE JUCE_ASIO=1)
  target_include_directories(yss-engine PRIVATE "${YSS_ASIO_SDK_DIR}")
endif()

# audio_utils 는 headless audio_processors 를 끌어옴 → full 을 직접 링크해 회피
target_link_libraries(yss-engine PRIVATE
  juce::juce_audio_processors
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_gui_extra
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)
